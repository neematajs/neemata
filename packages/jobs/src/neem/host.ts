import { randomUUID } from 'node:crypto'
import { inspect } from 'node:util'

import type { NeemRuntimeThreadHandle } from '@nmtjs/neem'
import { defineRuntimeHost } from '@nmtjs/neem'
import { UnrecoverableError, Worker } from 'bullmq'

import type { JobsClientInstance } from '../client.ts'
import type { AnyJob } from '../core/job.ts'
import type {
  JobsWorkerResponse,
  JobsWorkerTask,
  JobsWorkerTaskResult,
} from './protocol.ts'
import type { JobsConfig, JobsPoolConfig } from './runtime.ts'
import { closeJobsClient, resolveJobsClient } from '../client.ts'
import { getJobQueueName, JobManager } from '../manager.ts'
import { resolveJobsConfig } from './runtime.ts'

type JobsRuntimeState = {
  config?: Awaited<ReturnType<typeof resolveJobsConfig>>
  client?: JobsClientInstance
  manager?: JobManager
  jobs: Map<string, AnyJob>
  pools: Map<string, JobsRuntimeWorkerPool>
  queueWorkers: Set<Worker>
}

type JobsPlannerFactory = () => Promise<JobsConfig> | JobsConfig

export default defineRuntimeHost<JobsPlannerFactory | undefined>(
  async (params) => {
    const state: JobsRuntimeState = {
      jobs: new Map(),
      pools: new Map(),
      queueWorkers: new Set(),
    }

    async function stopJobsRuntime() {
      await Promise.allSettled(
        [...state.queueWorkers].map((worker) => worker.close(true)),
      )
      state.queueWorkers.clear()
      state.pools.clear()
      state.jobs.clear()
      state.config = undefined

      try {
        await state.manager?.terminate()
      } finally {
        state.manager = undefined
        if (state.client) await closeJobsClient(state.client)
        state.client = undefined
      }
    }

    return {
      async start() {
        const factory = params.options
        if (!factory)
          throw new Error('Jobs runtime planner options are missing')

        const resolved = await resolveJobsConfig(await factory())
        const jobs = new Map<string, AnyJob>()
        for (const job of resolved.jobs) jobs.set(job.name, job)
        validateJobs([...jobs.values()])
        assertPoolsConfigured(groupJobsByPool(jobs.values()), resolved.pools)
        state.config = resolved
        state.jobs = jobs

        const config = state.config
        const jobsByPool = groupJobsByPool(state.jobs.values())
        state.client = await resolveJobsClient(config.client)

        try {
          const manager = new JobManager(
            state.client,
            [...state.jobs.values()],
            config.hooks,
            (error, event, hook) => {
              params.logger.warn(
                { error, hook, jobId: event.id },
                'Neem jobs lifecycle hook failed',
              )
            },
          )
          state.manager = manager
          await manager.initialize()

          for (const [poolName, poolJobs] of jobsByPool) {
            const poolConfig = config.pools[poolName]!
            const pool = new JobsRuntimeWorkerPool(poolName)
            for (const thread of params.threads.filter((thread) =>
              thread.name.startsWith(`${params.name}:${poolName}:`),
            )) {
              pool.add(thread)
            }
            state.pools.set(poolName, pool)
            params.logger.info(`Neem jobs runner pool [${poolName}] started`)
            params.logger.trace(
              {
                pool: poolName,
                threads: pool.handles.length,
                jobsPerThread: poolConfig.jobs,
              },
              'Neem jobs runner pool',
            )

            for (const job of poolJobs) {
              const poolCapacity = poolConfig.threads * poolConfig.jobs
              const concurrency =
                job.options.concurrency ??
                Math.max(1, Math.floor(poolCapacity / poolJobs.length))

              const worker = new Worker(
                getJobQueueName(job),
                async (bullJob) => {
                  const result = await pool.run({
                    jobId: String(bullJob.id ?? ''),
                    jobName: bullJob.name,
                    data: bullJob.data,
                  })

                  switch (result.type) {
                    case 'success':
                      return result.result
                    case 'unrecoverable_error': {
                      const error = enrichBullMqErrorStack(result.error)
                      const unrecoverable = new UnrecoverableError(
                        error.message,
                      )
                      unrecoverable.stack = error.stack
                      throw unrecoverable
                    }
                    case 'job_not_found':
                    case 'queue_job_not_found':
                      throw new UnrecoverableError(result.type)
                    case 'error':
                      throw enrichBullMqErrorStack(result.error)
                  }
                },
                { connection: manager.connection, concurrency },
              )

              worker.on('active', (bullJob) => {
                void state.manager?.emitUpdated(bullJob)
              })
              worker.on('progress', (bullJob) => {
                void state.manager?.emitUpdated(bullJob)
              })
              worker.on('completed', (bullJob) => {
                void state.manager?.emitUpdated(bullJob, 'completed')
              })
              worker.on('failed', (bullJob) => {
                if (bullJob) void state.manager?.emitUpdated(bullJob, 'failed')
              })

              state.queueWorkers.add(worker)
              params.logger.info(`Neem jobs queue worker [${job.name}] started`)
              params.logger.trace(
                {
                  job: job.name,
                  queue: getJobQueueName(job),
                  pool: poolName,
                  concurrency,
                },
                'Neem jobs queue worker',
              )
            }
          }

          await Promise.all(
            [...state.queueWorkers].map((worker) => worker.waitUntilReady()),
          )
        } catch (error) {
          await stopJobsRuntime()
          throw error
        }
      },

      async stop() {
        await stopJobsRuntime()
      },
    }
  },
)

class JobsRuntimeWorkerPool {
  readonly handles: NeemRuntimeThreadHandle[] = []
  private index = 0

  constructor(readonly name: string) {}

  add(handle: NeemRuntimeThreadHandle) {
    this.handles.push(handle)
  }

  run(task: JobsWorkerTask): Promise<JobsWorkerTaskResult> {
    if (this.handles.length === 0) {
      throw new Error(`No job runners available for pool [${this.name}]`)
    }

    if (this.index >= this.handles.length) this.index = 0
    const handle = this.handles[this.index++]!
    const id = randomUUID()

    return new Promise((resolve, reject) => {
      const onMessage = (message: JobsWorkerResponse) => {
        if (message?.type !== 'task' || message.id !== id) return
        cleanup()
        resolve(message.task)
      }
      const onClose = () => {
        cleanup()
        reject(
          new Error(`Job runner [${handle.name}] closed during task [${id}]`),
        )
      }
      const cleanup = () => {
        handle.port.off('message', onMessage)
        handle.port.off('close', onClose)
      }

      handle.port.on('message', onMessage)
      handle.port.on('close', onClose)
      handle.port.postMessage({ type: 'task', id, task })
    })
  }
}

function validateJobs(jobs: readonly AnyJob[]) {
  for (const job of jobs) {
    if (!job.returnHandler) {
      throw new Error(
        `Job "${job.name}" is incomplete. Jobs must call .return() before use.`,
      )
    }
  }
}

function groupJobsByPool(jobs: Iterable<AnyJob>): Map<string, AnyJob[]> {
  const byPool = new Map<string, AnyJob[]>()
  for (const job of jobs) {
    const poolJobs = byPool.get(job.options.pool)
    if (poolJobs) poolJobs.push(job)
    else byPool.set(job.options.pool, [job])
  }
  return byPool
}

function assertPoolsConfigured(
  jobsByPool: Map<string, AnyJob[]>,
  pools: Record<string, JobsPoolConfig>,
) {
  const missing = [...jobsByPool]
    .filter(([poolName]) => !pools[poolName])
    .flatMap(([poolName, jobs]) =>
      jobs.map((job) => `${job.name} -> ${poolName}`),
    )

  if (missing.length > 0) {
    throw new Error(
      `Invalid jobs pool configuration: missing pool config for jobs: ${missing.join(', ')}`,
    )
  }
}

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
