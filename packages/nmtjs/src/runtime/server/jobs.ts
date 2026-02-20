import { inspect } from 'node:util'

import type { Logger } from '@nmtjs/core'
import type { RedisClient } from 'bullmq'
import { Queue, UnrecoverableError, Worker } from 'bullmq'

import type { AnyJob } from '../jobs/job.ts'
import type { JobsUI } from '../jobs/ui.ts'
import type { Store, WorkerJobTask } from '../types.ts'
import type { ServerConfig } from './config.ts'
import type { ErrorPolicy } from './error-policy.ts'
import type { ApplicationServerWorkerConfig } from './types.ts'
import type {
  ManagedWorkerFactory,
  WorkerPoolConfig,
  WorkerPoolFactory,
} from './worker-pool.ts'
import { JobWorkerPool, WorkerType } from '../enums.ts'
import { getJobQueueName } from '../jobs/manager.ts'
import { createJobsUI } from '../jobs/ui.ts'
import { JobRunnersPool } from './worker-pool.ts'

function enrichBullMqErrorStack(error: unknown): Error {
  const normalized =
    error instanceof Error
      ? error
      : new Error(
          typeof error === 'string' ? error : inspect(error, false, 20, false),
        )

  normalized.stack = inspect(normalized, false, 20, false)

  return normalized
}

/**
 * ApplicationServerJobs manages job worker pools and BullMQ queue workers.
 *
 * Changes from the old Pool-based implementation:
 * - Uses JobRunnersPool (extends WorkerPool) for worker management
 * - Uses ManagedWorker for restart logic and state tracking
 * - Integrates with ErrorPolicy for restart decisions
 * - Proper health tracking per job pool type
 */
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
      errorPolicy: ErrorPolicy
      workerFactory: ManagedWorkerFactory
      poolFactory: WorkerPoolFactory
    },
  ) {
    this.jobs = params.serverConfig.jobs
      ? params.serverConfig.jobs.jobs
      : new Map()
  }

  async start() {
    const {
      logger,
      serverConfig,
      workerConfig,
      store,
      errorPolicy,
      workerFactory,
    } = this.params
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

      // Create a JobRunnersPool for this pool type
      const config: WorkerPoolConfig = {
        name: `job-pool-${poolType}`,
        workerType: WorkerType.Job,
        path: workerConfig.path,
        workerData: { ...workerConfig.workerData },
        onWorker: workerConfig.worker,
      }

      const pool = new JobRunnersPool(
        config,
        errorPolicy,
        workerFactory,
        logger,
      )

      // Add workers to the pool
      for (let i = 0; i < poolConfig.threads; i++) {
        pool.add({ runtime: { type: 'jobs', jobWorkerPool: poolType } }, i)
      }

      await pool.startAll()
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
            case 'unrecoverable_error': {
              const error = enrichBullMqErrorStack(result.error)
              const unrecoverableError = new UnrecoverableError(error.message)
              unrecoverableError.stack = error.stack
              throw unrecoverableError
            }
            case 'job_not_found':
            case 'queue_job_not_found':
              throw new UnrecoverableError(result.type)
            case 'error':
              console.error(result.error)
              throw enrichBullMqErrorStack(result.error)
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

    // Force-close BullMQ workers immediately — stops accepting new jobs
    // and doesn't wait for in-flight processor callbacks.
    // We must use force=true on the first call because BullMQ caches the
    // closing promise: a second call with force=true returns the original
    // (non-force) promise, making it ineffective.
    // Interrupted jobs will be retried via BullMQ's stalled job mechanism.
    await Promise.all(
      [...this.queueWorkers].map(async (worker) => {
        try {
          await worker.close(true)
        } catch (error) {
          logger.warn({ error }, 'Failed to close BullMQ worker')
        }
      }),
    )
    this.queueWorkers.clear()

    // Stop job runner thread pools — sends 'stop' to threads, waits for
    // graceful exit with timeout, force-kills if needed.
    // Pending pool.run() calls will be rejected by ManagedWorker.stop().
    await Promise.all(
      Array.from(this.pools.values()).map(async (pool) => {
        try {
          await pool.stopAll()
        } catch (error) {
          logger.warn({ error }, 'Failed to stop job pool')
        }
      }),
    )
    this.pools.clear()

    // Close UI queues last (non-critical)
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
  }

  /**
   * Get a job pool by type.
   */
  getPool(poolType: JobWorkerPool): JobRunnersPool | undefined {
    return this.pools.get(poolType)
  }
}
