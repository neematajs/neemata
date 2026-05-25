import type {
  NeemEntryInput,
  NeemMaybePromise,
  NeemRuntimeBuildOptions,
  NeemRuntimeFactory,
} from '@nmtjs/neem'
import { defineRuntime, mergeNeemRuntimeBuildOptions } from '@nmtjs/neem'

import type { JobsClient } from '../client.ts'
import type { JobsLifecycleHooks } from '../core/hooks.ts'
import type { AnyJob } from '../core/job.ts'

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

export type ResolvedJobsWorkerConfig<Job extends AnyJobsJob = AnyJobsJob> = {
  client: JobsClient
  jobs: readonly Job[]
}

export type JobsRuntimeEntry<Job extends AnyJobsJob = AnyJobsJob> =
  JobsConfig<Job>

export type JobsRuntimeConfigInput<TConfig extends JobsConfig = JobsConfig> = {
  config: NeemEntryInput<TConfig>
}

const emptyHooks: JobsLifecycleHooks = Object.freeze({})

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
  config: JobsConfig<Job>,
): Promise<ResolvedJobsWorkerConfig<Job>> {
  return { client: config.client, jobs: await config.jobs() }
}

export function defineJobsRuntime<
  const TConfig extends JobsConfig = JobsConfig,
>(config: JobsRuntimeConfigInput<TConfig>): NeemRuntimeFactory {
  return (build?: NeemRuntimeBuildOptions) =>
    defineRuntime({
      entry: config.config,
      build: mergeNeemRuntimeBuildOptions(
        {
          host: { entry: '@nmtjs/jobs/neem/host' },
          artifacts: [
            { id: 'job-runner', kind: 'worker', entry: jobsWorkerEntry },
          ],
        },
        build,
      ),
    })
}

export const jobsWorkerEntry = '@nmtjs/jobs/neem/worker-entry'
