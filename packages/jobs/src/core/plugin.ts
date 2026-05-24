import type { RuntimePlugin } from '@nmtjs/application'
import { LifecycleHook } from '@nmtjs/application'
import { provision } from '@nmtjs/core'

import type { JobsClient, JobsClientInstance } from '../client.ts'
import type { JobsHookErrorHandler, JobsLifecycleHooks } from './hooks.ts'
import type { AnyJob } from './job.ts'
import { closeJobsClient, resolveJobsClient } from '../client.ts'
import { JobManager } from '../manager.ts'
import { jobManager } from './injectables.ts'

export type JobsApplicationPluginOptions<Job extends AnyJob = AnyJob> = {
  client: JobsClient
  jobs: readonly Job[]
  hooks?: JobsLifecycleHooks
  onHookError?: JobsHookErrorHandler
}

export function createJobsApplicationPlugin<const Job extends AnyJob>(
  options: JobsApplicationPluginOptions<Job>,
): RuntimePlugin {
  let client: JobsClientInstance | undefined
  let manager: JobManager | undefined

  return {
    name: 'jobs',
    hooks: {
      [LifecycleHook.BeforeInitialize]: async (ctx) => {
        client = await resolveJobsClient(options.client)
        try {
          manager = new JobManager(
            client,
            [...options.jobs],
            options.hooks,
            options.onHookError,
          )
          await manager.initialize()
          ctx.container.provide([provision(jobManager, manager.publicInstance)])
        } catch (error) {
          await closeJobsClient(client)
          client = undefined
          manager = undefined
          throw error
        }
      },
      [LifecycleHook.BeforeDispose]: async () => {
        try {
          await manager?.terminate()
        } finally {
          manager = undefined
          if (client) await closeJobsClient(client)
          client = undefined
        }
      },
    },
  }
}
