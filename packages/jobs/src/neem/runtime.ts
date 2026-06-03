import type { MaybePromise } from '@nmtjs/common'
import type {
  NeemEntryInput,
  NeemRuntimeDeclaration,
  NeemRuntimePlan,
} from '@nmtjs/neem'
import { createRuntime, defineRuntimePlanner } from '@nmtjs/neem'

import type { JobsClient } from '../client.ts'
import type { JobsLifecycleHooks } from '../core/hooks.ts'
import type { AnyJob } from '../core/job.ts'
import type { JobsWorkerData } from './protocol.ts'

export type AnyJobsJob = AnyJob

export type JobsPoolConfig = { threads: number; jobs: number }

export type JobsFactory<Job extends AnyJobsJob = AnyJobsJob> =
  () => MaybePromise<readonly Job[]>

export type JobsHooksFactory = () => MaybePromise<
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

export type ResolvedJobsWorkerConfig<Job extends AnyJobsJob = AnyJobsJob> = {
  client: JobsClient
  jobs: readonly Job[]
}

export type JobsRuntimeEntry<Job extends AnyJobsJob = AnyJobsJob> =
  JobsConfig<Job>

export type JobsRuntimeConfigInput = {
  name?: string
  planner?: NeemEntryInput
  worker: NeemEntryInput
}

const emptyHooks: JobsLifecycleHooks = Object.freeze({})
const defineJobsRuntimeProject = createRuntime({
  host: { entry: '@nmtjs/jobs/neem/host' },
})

export function defineJobs<const Job extends AnyJobsJob>(
  config: JobsConfig<Job>,
): JobsConfig<Job> {
  return Object.freeze(config)
}

export async function resolveJobsConfig<const Job extends AnyJobsJob>(
  config: JobsConfig<Job>,
): Promise<ResolvedJobsConfig<Job>> {
  return {
    client: config.client,
    pools: config.pools,
    jobs: await config.jobs(),
    hooks: (await config.hooks?.()) ?? emptyHooks,
  }
}

export async function resolveJobsWorkerConfig<const Job extends AnyJobsJob>(
  config: Pick<JobsConfig<Job>, 'client' | 'jobs'>,
): Promise<ResolvedJobsWorkerConfig<Job>> {
  return { client: config.client, jobs: await config.jobs() }
}

export function defineJobsRuntime(
  config: JobsRuntimeConfigInput,
): NeemRuntimeDeclaration {
  return defineJobsRuntimeProject({
    name: config.name,
    planner: config.planner,
    worker: { entry: config.worker },
  })
}

export function defineJobsPlanner<
  const TConfig extends JobsConfig = JobsConfig,
>(factory: () => MaybePromise<TConfig>) {
  return defineRuntimePlanner(
    async (): Promise<NeemRuntimePlan<typeof factory, JobsWorkerData>> => {
      const config = await factory()
      const jobs = await config.jobs()
      const jobsByPool = groupJobsByPool(jobs)
      assertPoolsConfigured(jobsByPool, config.pools)

      return {
        workers: Object.fromEntries(
          [...jobsByPool.keys()].map((poolName) => [
            poolName,
            Array.from(
              { length: config.pools[poolName]!.threads },
              (): JobsWorkerData => ({ poolName }),
            ),
          ]),
        ),
        options: factory,
      }
    },
  )
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
