import { inspect } from 'node:util'

import type { Logger } from '@nmtjs/core'
import type { RedisClient } from 'bullmq'
import { UnrecoverableError, Worker } from 'bullmq'

import type { AnyJob } from '../jobs/job.ts'
import type { Store, WorkerJobTask } from '../types.ts'
import type { ServerConfig } from './config.ts'
import type { ErrorPolicy } from './error-policy.ts'
import type { ApplicationServerWorkerConfig } from './types.ts'
import type {
  ManagedWorkerFactory,
  WorkerPoolConfig,
  WorkerPoolFactory,
} from './worker-pool.ts'
import { WorkerType } from '../enums.ts'
import { getJobQueueName } from '../jobs/manager.ts'
import { JobRunnersPool } from './worker-pool.ts'

type JobsPoolConfig = Exclude<ServerConfig['jobs'], undefined>['pools']

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

function getJobsByPool(jobs: Iterable<AnyJob>): Map<string, AnyJob[]> {
  const jobsByPool = new Map<string, AnyJob[]>()

  for (const job of jobs) {
    const poolJobs = jobsByPool.get(job.options.pool)
    if (poolJobs) {
      poolJobs.push(job)
    } else {
      jobsByPool.set(job.options.pool, [job])
    }
  }

  return jobsByPool
}

function assertActiveJobPoolsConfigured(
  jobsByPool: Map<string, AnyJob[]>,
  pools: JobsPoolConfig,
) {
  const missingPoolMessages = [...jobsByPool]
    .filter(([poolName]) => !pools[poolName])
    .flatMap(([poolName, jobs]) =>
      jobs.map((job) => `${job.name} -> ${poolName}`),
    )

  if (missingPoolMessages.length > 0) {
    throw new Error(
      `Invalid jobs pool configuration: missing pool config for jobs: ${missingPoolMessages.join(', ')}`,
    )
  }
}

/**
 * ApplicationServerJobs manages job worker pools and BullMQ queue workers.
 *
 * Changes from the old Pool-based implementation:
 * - Uses JobRunnersPool (extends WorkerPool) for worker management
 * - Uses ManagedWorker for restart logic and state tracking
 * - Integrates with ErrorPolicy for restart decisions
 * - Proper health tracking per job pool
 */
export class ApplicationServerJobs {
  /**
   * BullMQ workers - one per job (dedicated queues)
   */
  queueWorkers = new Set<Worker>()

  jobs: Map<string, AnyJob>

  /**
   * Shared resource pools by configured pool name.
   * All jobs using the same pool name share the same pool for resource management.
   */
  protected pools = new Map<string, JobRunnersPool>()

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

    const jobsByPool = getJobsByPool(this.jobs.values())
    assertActiveJobPoolsConfigured(jobsByPool, jobsConfig.pools)

    // Step 1: Initialize shared resource pools used by active jobs
    for (const poolName of jobsByPool.keys()) {
      const poolConfig = jobsConfig.pools[poolName]!

      // Create a JobRunnersPool for this pool
      const config: WorkerPoolConfig = {
        name: `job-pool-${poolName}`,
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
        pool.add({ runtime: { type: 'jobs', jobWorkerPool: poolName } }, i)
      }

      await pool.startAll()
      this.pools.set(poolName, pool)

      logger.info(
        {
          pool: poolName,
          threads: poolConfig.threads,
          jobsPerThread: poolConfig.jobs,
        },
        'Job runner pool started',
      )
    }

    // Step 2: Create a dedicated BullMQ Worker for each job
    // Calculate how many jobs use each pool for fair concurrency distribution
    for (const job of this.jobs.values()) {
      const queueName = getJobQueueName(job)
      const poolName = job.options.pool
      const pool = this.pools.get(poolName)

      if (!pool) {
        throw new Error(`Job "${job.name}" pool "${poolName}" is not started`)
      }

      const poolConfig = jobsConfig.pools[poolName]!
      const poolCapacity = poolConfig.threads * poolConfig.jobs
      const jobCountInPool = jobsByPool.get(poolName)?.length ?? 1
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
        { job: job.name, queue: queueName, pool: poolName, concurrency },
        'Job queue worker started',
      )
    }
  }

  async stop() {
    const { logger } = this.params

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
  }

  /**
   * Get a job pool by name.
   */
  getPool(poolName: string): JobRunnersPool | undefined {
    return this.pools.get(poolName)
  }
}
