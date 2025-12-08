import type { Worker } from 'node:worker_threads'
import assert from 'node:assert'
import EventEmitter from 'node:events'

import type { Logger } from '@nmtjs/core'
import type { NeemataProxy } from '@nmtjs/proxy'
import type { RedisClient } from 'bullmq'
import type { FastifyInstance } from 'fastify'
import { createLogger } from '@nmtjs/core'
import { ProxyableTransportType } from '@nmtjs/gateway'
import { Queue, Worker as QueueWorker, UnrecoverableError } from 'bullmq'

import type { Store } from '../types.ts'
import type { ServerApplicationConfig, ServerConfig } from './config.ts'
import { JobWorkerQueue } from '../enums.ts'
import { createJobsUI } from '../jobs/ui.ts'
import { JobsScheduler } from '../scheduler/index.ts'
import { createStoreClient } from '../store/index.ts'
import { Pool } from './pool.ts'

export type ApplicationServerRunOptions = {
  applications: string[]
  scheduler: boolean
  jobs: boolean
}

export class ApplicationServer extends EventEmitter {
  logger: Logger
  pools: {
    applications?: Pool
    [JobWorkerQueue.Io]?: Pool
    [JobWorkerQueue.Compute]?: Pool
  } = {}
  transports: { [key: string]: { [key: string]: any } } = {}
  queueWorkers = new Set<QueueWorker>()
  proxy?: NeemataProxy
  store?: Store
  scheduler?: JobsScheduler
  jobsUi?: FastifyInstance

  constructor(
    readonly config: ServerConfig,
    readonly applications: Record<string, string>,
    readonly workerConfig: {
      path: string
      workerData?: any
      worker?: (worker: Worker) => any
    },
    readonly runOptions: ApplicationServerRunOptions = {
      applications: Object.keys(config.applications),
      scheduler: true,
      jobs: true,
    },
  ) {
    super()
    this.logger = createLogger(config.logger, 'Server')
  }

  async start() {
    const { config, logger } = this
    logger.info('Starting application server...')

    if (config.store) {
      const store = await createStoreClient(config.store)
      this.store = store
    }

    if (this.runOptions.scheduler && config.jobs?.scheduler && this.store) {
      const scheduler = new JobsScheduler(
        this.store,
        config.deploymentId,
        config!.jobs?.scheduler?.entries ?? [],
      )

      this.scheduler = scheduler
    }

    this.pools.applications = new Pool({
      filename: this.workerConfig.path,
      worker: this.workerConfig.worker,
      workerData: { ...this.workerConfig.workerData },
    })

    const proxyUpstreams: Record<
      string,
      { type: 'http' | 'websocket'; url: string }[]
    > = {}

    for (const applicationName in this.config.applications) {
      if (!this.runOptions.applications.includes(applicationName)) continue
      const applicationPath = this.applications[applicationName]
      const applicationConfig = this.config.applications[
        applicationName
      ] as ServerApplicationConfig
      const threadsConfig = Array.isArray(applicationConfig.threads)
        ? applicationConfig.threads
        : new Array(applicationConfig.threads).fill(undefined)
      this.logger.info(
        `Spinning [${threadsConfig.length}] workers for [${applicationName}] application...`,
      )

      for (let i = 0; i < threadsConfig.length; i++) {
        const thread = this.pools.applications.add({
          index: i,
          name: `application-${applicationName}`,
          workerData: {
            runtime: {
              type: 'application',
              name: applicationName,
              path: applicationPath,
              transportsData: threadsConfig[i],
            },
          },
        })

        if (this.config.proxy) {
          thread.on('ready', ({ hosts }) => {
            if (hosts) {
              proxyUpstreams[applicationName] ??= []
              for (const host of hosts) {
                const url = new URL(host.url)
                if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1'
                proxyUpstreams[applicationName].push({
                  type: {
                    [ProxyableTransportType.HTTP]: 'http' as const,
                    [ProxyableTransportType.WebSocket]: 'websocket' as const,
                  }[host.type],
                  url: url.toString(),
                })
              }
            }
          })
        }
      }
    }

    if (config.jobs && this.runOptions.jobs) {
      if (config.jobs.ui) {
        const queues = Object.values(JobWorkerQueue).map(
          (q) => new Queue(q, { connection: this.store! as RedisClient }),
        )
        this.jobsUi = createJobsUI(queues)
        const address = await this.jobsUi.listen({
          host: config.jobs.ui.hostname,
          port: config.jobs.ui.port,
        })
        logger.info('Jobs UI listening on %s', address)
      }

      for (const jobWorkerQueue of Object.values(JobWorkerQueue)) {
        logger.debug('Spinning compute workers...')

        const poolConfig = config.jobs.queues[jobWorkerQueue]

        this.logger.info(
          `Spinning [${poolConfig.threads}] workers for [${jobWorkerQueue}] queue...`,
        )

        const pool = new Pool({
          filename: this.workerConfig.path,
          worker: this.workerConfig.worker,
          workerData: { ...this.workerConfig.workerData },
        })

        this.pools[jobWorkerQueue] = pool

        for (let i = 0; i < poolConfig.threads; i++) {
          this.pools[jobWorkerQueue]!.add({
            index: i,
            name: `job-worker-${jobWorkerQueue.toLowerCase()}`,
            workerData: { runtime: { type: 'jobs', jobWorkerQueue } },
          })
        }

        const bullWorkerOptions = {
          concurrency: Math.floor(poolConfig.jobs * poolConfig.threads),
          // TODO: these should be configurable
          lockDuration: 10000,
        }
        logger.debug(
          bullWorkerOptions,
          `Start processing [${bullWorkerOptions.concurrency}] jobs for [${jobWorkerQueue}] queue...`,
        )
        const queueWorker = new QueueWorker(
          jobWorkerQueue,
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
              data: job.data,
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
          {
            ...bullWorkerOptions,
            connection: this.store! as RedisClient,
            autorun: false,
          },
        )
        this.queueWorkers.add(queueWorker)
      }
    }

    await Promise.all([
      ...Object.values(this.pools)
        .filter(Boolean)
        .map((pool) => pool!.start()),
    ])

    for (const worker of this.queueWorkers) {
      worker.run()
    }

    if (this.config.proxy && Object.keys(proxyUpstreams).length > 0) {
      const { NeemataProxy } = await import('@nmtjs/proxy')
      const upstreams = Object.fromEntries(
        Object.entries(proxyUpstreams).map(([app, upstreams]) => [
          app,
          { upstreams },
        ]),
      )
      this.logger.info(
        { ...this.config.proxy, upstreams },
        'Starting proxy server...',
      )

      this.proxy = new NeemataProxy(upstreams, {
        healthCheckInterval: 60,
        listen: `${this.config.proxy.hostname}:${this.config.proxy.port}`,
        threads: this.config.proxy.threads,
      })
      this.proxy.run()
    }

    this.logger.debug('Application server started')
  }

  async stop() {
    this.logger.debug('Stopping application server...')

    if (this.proxy) {
      this.logger.debug('Stopping proxy...')
      this.proxy.shutdown()
    }

    if (this.queueWorkers.size) {
      this.logger.debug('Stopping queue workers...')
      await Promise.allSettled(
        Array.from(this.queueWorkers).map((worker) => worker.close()),
      )
    }
    if (this.jobsUi) {
      this.logger.debug('Stopping Jobs UI...')
      await this.jobsUi.close()
    }
    const pools = Object.values(this.pools).filter(Boolean) as Pool[]
    this.logger.debug('Stopping pools workers...')
    await Promise.allSettled(pools.map((pool) => pool.stop()))
    if (this.store) {
      this.logger.debug('Closing store...')
      this.store.disconnect(false)
    }
    this.emit('stop')
    this.logger.debug('Application server stopped')
  }
}
