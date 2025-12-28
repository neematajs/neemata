import type { Logger } from '@nmtjs/core'
import type { RedisClient } from 'bullmq'
import { Queue, UnrecoverableError, Worker } from 'bullmq'

import type { AnyJob } from '../jobs/job.ts'
import type { JobsUI } from '../jobs/ui.ts'
import type { JobTaskResult, Store, WorkerJobTask } from '../types.ts'
import type { ServerConfig } from './config.ts'
import type { ApplicationServerWorkerConfig } from './server.ts'
import { JobWorkerPool } from '../enums.ts'
import { getJobQueueName } from '../jobs/manager.ts'
import { createJobsUI } from '../jobs/ui.ts'
import { Pool } from './pool.ts'

export class JobRunnersPool extends Pool {
  protected runIndex = 0

  async run(task: WorkerJobTask): Promise<JobTaskResult> {
    if (this.threads.length === 0) {
      throw new Error('No job runner threads available')
    }

    if (this.runIndex >= this.threads.length) {
      this.runIndex = 0
    }

    const thread = this.threads[this.runIndex]!
    this.runIndex++
    return await thread.run(task)
  }
}

export class ApplicationServerJobs {
  /**
   * BullMQ workers - one per job (dedicated queues)
   */
  queueWorkers = new Set<Worker>()
  ui?: JobsUI
  protected uiQueues: Queue[] = []

  jobs: Map<string, AnyJob>

  /**
   * Shared resource pools by pool type (Io, Compute).
   * All jobs of a given pool type share the same pool for resource management.
   */
  protected pools = new Map<JobWorkerPool, JobRunnersPool>()

  constructor(
    readonly params: {
      logger: Logger
      serverConfig: ServerConfig
      workerConfig: ApplicationServerWorkerConfig
      store: Store
    },
  ) {
    this.jobs = params.serverConfig.jobs
      ? params.serverConfig.jobs.jobs
      : new Map()
  }

  async start() {
    const { logger, serverConfig, workerConfig, store } = this.params
    const jobsConfig = serverConfig.jobs

    if (!jobsConfig) {
      logger.debug('Jobs are not configured, skipping')
      return
    }

    if (jobsConfig.ui) {
      const hostname = jobsConfig.ui.hostname ?? '127.0.0.1'
      const port = jobsConfig.ui.port ?? 3000

      this.uiQueues = [...this.jobs.values()].map(
        (job) =>
          new Queue(getJobQueueName(job), {
            connection: store as unknown as RedisClient,
          }),
      )

      this.ui = createJobsUI(this.uiQueues)

      await new Promise<void>((resolve, reject) => {
        if (!this.ui) return reject(new Error('Jobs UI server is missing'))
        this.ui.once('error', reject)
        this.ui.listen(port, hostname, resolve)
      })

      const address = this.ui.address()
      const resolved =
        address && typeof address !== 'string'
          ? { hostname: address.address, port: address.port }
          : { hostname, port }

      logger.info({ ...resolved }, 'Jobs UI started')
    }

    // Step 1: Initialize shared resource pools (Io, Compute)
    const poolTypes = Object.values(JobWorkerPool)

    for (const poolType of poolTypes) {
      const poolConfig = jobsConfig.pools[poolType]
      if (!poolConfig) continue

      const pool = new JobRunnersPool({
        path: workerConfig.path,
        worker: workerConfig.worker,
        workerData: { ...workerConfig.workerData },
      })

      for (let i = 0; i < poolConfig.threads; i++) {
        pool.add({
          index: i,
          name: `job-pool-${poolType}`,
          workerData: { runtime: { type: 'jobs', jobWorkerPool: poolType } },
        })
      }

      await pool.start()
      this.pools.set(poolType, pool)

      logger.info(
        {
          pool: poolType,
          threads: poolConfig.threads,
          jobsPerThread: poolConfig.jobs,
        },
        'Job runner pool started',
      )
    }

    // Step 2: Create a dedicated BullMQ Worker for each job
    // Calculate how many jobs use each pool for fair concurrency distribution
    const jobsPerPool = new Map<JobWorkerPool, number>()
    for (const job of this.jobs.values()) {
      const count = jobsPerPool.get(job.options.pool) ?? 0
      jobsPerPool.set(job.options.pool, count + 1)
    }

    for (const job of this.jobs.values()) {
      const queueName = getJobQueueName(job)
      const poolType = job.options.pool
      const pool = this.pools.get(poolType)

      if (!pool) {
        logger.warn(
          { job: job.name, pool: poolType },
          'No pool configured for job, skipping worker creation',
        )
        continue
      }

      const poolConfig = jobsConfig.pools[poolType]
      const poolCapacity = poolConfig.threads * poolConfig.jobs
      const jobCountInPool = jobsPerPool.get(poolType) ?? 1
      // Use job-specific concurrency if provided, otherwise distribute pool capacity evenly
      const defaultConcurrency = Math.max(
        1,
        Math.floor(poolCapacity / jobCountInPool),
      )
      const concurrency = job.options.concurrency ?? defaultConcurrency

      const queueWorker = new Worker(
        queueName,
        async (bullJob) => {
          const task: WorkerJobTask = {
            jobId: String(bullJob.id ?? ''),
            jobName: bullJob.name,
            data: bullJob.data,
          }

          const result = await pool.run(task)
          switch (result.type) {
            case 'success':
              return result.result
            case 'unrecoverable_error':
              throw new UnrecoverableError(
                typeof result.error === 'string'
                  ? result.error
                  : 'Unrecoverable error',
              )
            case 'job_not_found':
            case 'queue_job_not_found':
              throw new UnrecoverableError(result.type)
            case 'error':
              console.error(result.error)
              throw result.error
            default:
              throw new UnrecoverableError('Unknown job task result')
          }
        },
        { connection: store as unknown as RedisClient, concurrency },
      )

      this.queueWorkers.add(queueWorker)
      logger.info(
        { job: job.name, queue: queueName, pool: poolType, concurrency },
        'Job queue worker started',
      )
    }
  }

  async stop() {
    const { logger } = this.params

    if (this.ui) {
      await new Promise<void>((resolve) => {
        this.ui?.close(() => resolve())
      }).catch((error) => {
        logger.warn({ error }, 'Failed to stop Jobs UI server')
      })
    }

    await Promise.all(
      this.uiQueues.map(async (queue) => {
        try {
          await queue.close()
        } catch (error) {
          logger.warn({ error }, 'Failed to close Jobs UI queue')
        }
      }),
    )
    this.uiQueues = []
    this.ui = undefined

    // Stop accepting new jobs first.
    await Promise.all(
      [...this.queueWorkers].map(async (worker) => {
        try {
          await worker.close()
        } catch (error) {
          logger.warn({ error }, 'Failed to close BullMQ worker')
        }
      }),
    )
    this.queueWorkers.clear()

    await Promise.all(
      Array.from(this.pools.values()).map(async (pool) => {
        try {
          await pool.stop()
        } catch (error) {
          logger.warn({ error }, 'Failed to stop job pool')
        }
      }),
    )
    this.pools.clear()
  }
}
