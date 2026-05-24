import type { NeemArtifact, NeemMaybePromise } from '@nmtjs/neem'

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

export function defineJobsRuntimeArtifacts(): readonly NeemArtifact[] {
  return [{ id: 'job-runner', kind: 'worker', entry: jobsWorkerEntry }]
}

export const jobsWorkerEntry = new URL('./worker-entry.js', import.meta.url)
