import { randomUUID } from 'node:crypto'
import { inspect } from 'node:util'

import type {
  NeemMaybePromise,
  NeemPlugin,
  NeemPluginContext,
} from '@nmtjs/neem'
import { definePlugin } from '@nmtjs/neem'
import { UnrecoverableError, Worker } from 'bullmq'

import type { JobsClient, JobsClientInstance } from '../client.ts'
import type { JobsLifecycleHooks } from '../core/hooks.ts'
import type { AnyJob } from '../core/job.ts'
import type {
  JobsWorkerResponse,
  JobsWorkerTask,
  JobsWorkerTaskResult,
} from './protocol.ts'
import { closeJobsClient, resolveJobsClient } from '../client.ts'
import { getJobQueueName, JobManager } from '../manager.ts'

export type AnyJobsJob = AnyJob

export type JobsPoolConfig = { threads: number; jobs: number }

export type JobsFactory<Job extends AnyJobsJob = AnyJobsJob> =
  () => NeemMaybePromise<readonly Job[]>

export type JobsHooksFactory = () => NeemMaybePromise<
  JobsLifecycleHooks | undefined
>

export type JobsConfig<Job extends AnyJobsJob = AnyJobsJob> = {
  client: JobsClient
  pools: Record<string, JobsPoolConfig>
  jobs: JobsFactory<Job>
  hooks?: JobsHooksFactory
}

export type ResolvedJobsConfig<Job extends AnyJobsJob = AnyJobsJob> = {
  client: JobsClient
  pools: Record<string, JobsPoolConfig>
  jobs: readonly Job[]
  hooks: JobsLifecycleHooks
}

export type JobsPlugin<Job extends AnyJobsJob = AnyJobsJob> = NeemPlugin & {
  jobsConfig: JobsConfig<Job>
}

const emptyHooks: JobsLifecycleHooks = Object.freeze({})

export function defineJobs<const Job extends AnyJobsJob>(
  config: JobsConfig<Job>,
): JobsPlugin<Job> {
  let runtime: JobsPluginRuntime | undefined

  return definePlugin({
    name: 'jobs',
    jobsConfig: config,

    artifacts() {
      return [
        { id: 'job-runner', kind: 'worker', entry: resolveJobsWorkerEntry() },
      ]
    },

    async setup(ctx) {
      const resolved = await resolveJobsConfig(config)
      runtime = new JobsPluginRuntime(ctx, resolved)
      await runtime.start()
    },

    async stop() {
      await runtime?.stop()
      runtime = undefined
    },
  } as JobsPlugin<Job>)
}

export async function resolveJobsConfig<const Job extends AnyJobsJob>(
  config: JobsConfig<Job>,
  _ctx?: NeemPluginContext,
): Promise<ResolvedJobsConfig<Job>> {
  return {
    client: config.client,
    pools: config.pools,
    jobs: await config.jobs(),
    hooks: (await config.hooks?.()) ?? emptyHooks,
  }
}

class JobsPluginRuntime {
  private manager: JobManager | undefined
  private client: JobsClientInstance | undefined
  private readonly pools = new Map<string, JobsWorkerPool>()
  private readonly queueWorkers = new Set<Worker>()
  private readonly jobs = new Map<string, AnyJob>()

  constructor(
    private readonly ctx: NeemPluginContext,
    private readonly config: ResolvedJobsConfig,
  ) {
    for (const job of config.jobs) this.jobs.set(job.name, job)
  }

  async start() {
    validateJobs([...this.jobs.values()])
    const jobsByPool = groupJobsByPool(this.jobs.values())
    assertPoolsConfigured(jobsByPool, this.config.pools)
    this.client = await resolveJobsClient(this.config.client)

    try {
      this.manager = new JobManager(
        this.client,
        [...this.jobs.values()],
        this.config.hooks,
        (error, event, hook) => {
          this.ctx.logger.warn(
            { error, hook, jobId: event.id },
            'Neem jobs lifecycle hook failed',
          )
        },
      )
      await this.manager.initialize()
    } catch (error) {
      await closeJobsClient(this.client)
      this.client = undefined
      this.manager = undefined
      throw error
    }

    for (const poolName of jobsByPool.keys()) {
      const poolConfig = this.config.pools[poolName]!
      const pool = new JobsWorkerPool(poolName)

      for (let index = 0; index < poolConfig.threads; index++) {
        pool.add(
          await this.ctx.workers.spawn({
            id: `jobs:${poolName}:${index}`,
            name: `jobs:${poolName}:${index}`,
            artifact: 'job-runner',
            workerData: {
              poolName,
              pluginEntryFile: this.ctx.artifacts.resolve('entry')!.file,
            },
          }),
        )
      }

      this.pools.set(poolName, pool)
      this.ctx.logger.info(
        {
          pool: poolName,
          threads: poolConfig.threads,
          jobsPerThread: poolConfig.jobs,
        },
        'Neem jobs runner pool started',
      )
    }

    for (const job of this.jobs.values()) {
      const pool = this.pools.get(job.options.pool)
      if (!pool) {
        throw new Error(
          `Job "${job.name}" pool "${job.options.pool}" is not started`,
        )
      }

      const poolConfig = this.config.pools[job.options.pool]!
      const jobsInPool = jobsByPool.get(job.options.pool)?.length ?? 1
      const poolCapacity = poolConfig.threads * poolConfig.jobs
      const concurrency =
        job.options.concurrency ??
        Math.max(1, Math.floor(poolCapacity / jobsInPool))

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
              const unrecoverable = new UnrecoverableError(error.message)
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
        { connection: this.manager.connection, concurrency },
      )

      worker.on('active', (bullJob) => {
        void this.manager?.emitUpdated(bullJob)
      })
      worker.on('progress', (bullJob) => {
        void this.manager?.emitUpdated(bullJob)
      })
      worker.on('completed', (bullJob) => {
        void this.manager?.emitUpdated(bullJob, 'completed')
      })
      worker.on('failed', (bullJob) => {
        if (bullJob) void this.manager?.emitUpdated(bullJob, 'failed')
      })

      this.queueWorkers.add(worker)
      this.ctx.logger.info(
        {
          job: job.name,
          queue: getJobQueueName(job),
          pool: job.options.pool,
          concurrency,
        },
        'Neem jobs queue worker started',
      )
    }
  }

  async stop() {
    await Promise.allSettled(
      [...this.queueWorkers].map((worker) => worker.close(true)),
    )
    this.queueWorkers.clear()

    await Promise.allSettled(
      [...this.pools.values()].flatMap((pool) =>
        pool.handles.map((worker) => worker.stop()),
      ),
    )
    this.pools.clear()

    try {
      await this.manager?.terminate()
    } finally {
      this.manager = undefined
      if (this.client) await closeJobsClient(this.client)
      this.client = undefined
    }
  }
}

class JobsWorkerPool {
  readonly handles = [] as Awaited<
    ReturnType<NeemPluginContext['workers']['spawn']>
  >[]

  private index = 0

  constructor(readonly name: string) {}

  add(handle: Awaited<ReturnType<NeemPluginContext['workers']['spawn']>>) {
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
          new Error(`Job runner [${handle.id}] closed during task [${id}]`),
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

function resolveJobsWorkerEntry(): URL {
  return new URL('./worker-entry.js', import.meta.url)
}
