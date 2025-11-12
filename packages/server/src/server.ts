import assert from 'node:assert'
import EventEmitter from 'node:events'

import type { Logger } from '@nmtjs/core'
import { ApplicationType, ApplicationWorkerType } from '@nmtjs/application'
import { createLogger } from '@nmtjs/core'
import { Worker as QueueWorker, UnrecoverableError } from 'bullmq'
import { Redis } from 'ioredis'

import type { ServerConfig } from './config.ts'
import { Pool } from './pool.ts'
import { JobsScheduler } from './scheduler.ts'

export class ApplicationServer extends EventEmitter {
  logger: Logger
  redis?: Redis
  scheduler?: JobsScheduler

  apiWorkers!: Pool
  computeWorkers!: Pool
  ioWorkers!: Pool
  queueWorkers = new Set<QueueWorker>()

  #exiting: Promise<any> | null = null

  constructor(
    readonly config: ServerConfig,
    readonly workerConfig: { path: string; workerData?: any },
  ) {
    super()
    this.logger = createLogger(config.logger, 'Application Server')
    let redis: Redis | undefined
    let scheduler: JobsScheduler | undefined
    if (config.redis) {
      redis = new Redis({ ...config.redis, lazyConnect: true })
      scheduler = new JobsScheduler(
        redis,
        config.deploymentId,
        config!.scheduler?.entries ?? [],
      )
    }
    this.redis = redis
    this.scheduler = scheduler
  }

  async start() {
    const { config, logger } = this
    logger.info('Starting application server...')

    await this.redis?.connect()
    await this.scheduler?.initialize()

    const apiWorkersNum = Array.isArray(
      config.workers[ApplicationWorkerType.Api],
    )
      ? config.workers[ApplicationWorkerType.Api].length
      : config.workers[ApplicationWorkerType.Api]

    logger.debug('Spinning api workers...')
    this.apiWorkers = new Pool({
      filename: this.workerConfig.path,
      name: 'api',
      threadsNumber: apiWorkersNum,
      workerData: {
        ...this.workerConfig.workerData,
        type: ApplicationType.Api,
        workerType: ApplicationWorkerType.Api,
      },
      extraWorkerData: Array.isArray(config.workers[ApplicationWorkerType.Api])
        ? (index: number) => {
            return {
              applicationWorkerData:
                config.workers[ApplicationWorkerType.Api][index],
            }
          }
        : undefined,
    })

    logger.debug('Spinning compute workers...')
    const computeWorkersConfig = config.workers[ApplicationWorkerType.Compute]
    this.computeWorkers = new Pool({
      filename: this.workerConfig.path,
      name: 'compute',
      threadsNumber: computeWorkersConfig.threadsNumber,
      workerData: {
        ...this.workerConfig.workerData,
        type: ApplicationType.Job,
        workerType: ApplicationWorkerType.Compute,
      },
    })

    logger.debug('Spinning io workers...')
    const ioWorkersConfig = config.workers[ApplicationWorkerType.Io]
    this.ioWorkers = new Pool({
      filename: this.workerConfig.path,
      name: 'io',
      threadsNumber: ioWorkersConfig.threadsNumber,
      workerData: {
        ...this.workerConfig.workerData,
        type: ApplicationType.Job,
        workerType: ApplicationWorkerType.Io,
      },
    })

    await Promise.all([
      this.apiWorkers.start(),
      this.computeWorkers.start(),
      this.ioWorkers.start(),
    ])

    if (this.scheduler) {
      for (const queue of this.scheduler.queues) {
        if (
          queue.name !== ApplicationWorkerType.Io &&
          queue.name !== ApplicationWorkerType.Compute
        )
          continue

        const config = this.config.workers[queue.name]
        if (config.threadsNumber <= 0) continue

        const pool =
          queue.name === ApplicationWorkerType.Io
            ? this.ioWorkers
            : this.computeWorkers

        const bullWorkerOptions = {
          concurrency: Math.floor(config.jobsPerWorker * config.threadsNumber),
          // TODO: these should be configurable
          lockDuration: 10000,
        }
        logger.info(
          bullWorkerOptions,
          `Starting processing jobs from [${queue.name}] queue with [${config.threadsNumber}] workers...`,
        )
        const queueWorker = new QueueWorker(
          queue.name,
          async (job) => {
            const jobLogger = this.logger.child({
              jobId: job.id,
              jobName: job.name,
              queueName: job.queueName,
            })
            jobLogger.debug('Processing job...')
            assert(job.id, 'Job id is missing')
            const runResult = await pool.run({
              jobId: job.id!,
              jobName: job.name,
            })
            jobLogger.debug(runResult, 'Job processed')
            switch (runResult.type) {
              case 'success':
                return runResult.result
              case 'job_not_found':
              case 'queue_job_not_found':
                throw new UnrecoverableError(`Job not found: ${runResult.type}`)
              case 'error':
                throw (
                  runResult.error ||
                  new Error(`Job failed with type: ${runResult.type}`)
                )
            }
          },
          { ...bullWorkerOptions, connection: this.redis! },
        )
        this.queueWorkers.add(queueWorker)
      }
    }
  }

  async stop() {
    this.logger.info('Stopping application server...')
    this.logger.info('Stopping queue workers...')
    await Promise.allSettled(
      Array.from(this.queueWorkers).map((worker) => worker.close()),
    )
    const pools = [this.apiWorkers, this.computeWorkers, this.ioWorkers]
    this.logger.info('Stopping pools workers...')
    await Promise.allSettled(pools.map((pool) => pool?.stop()))
    this.logger.info('Stopping redis...')
    this.redis?.disconnect(false)
    this.emit('stop')
  }
}
