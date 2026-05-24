import type {
  JobsHookEvent,
  JobsHookRemovedEvent,
  JobsLifecycleHooks,
} from '@nmtjs/jobs'
import type { NeemPluginContext } from '@nmtjs/neem'
import { createLogger } from '@nmtjs/core'
import { callJobsHook, createJob, createStep, jobManager } from '@nmtjs/jobs'
import { defineJobs, resolveJobsConfig } from '@nmtjs/jobs/neem'
import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it } from 'vitest'

describe('@nmtjs/jobs plugin contracts', () => {
  it('defines a Neem plugin from async jobs and hook factories', async () => {
    const calls: unknown[] = []
    const importUsersJob = createJob({
      name: 'import-users',
      pool: 'default',
      input: t.object({}),
      output: t.object({}),
    }).return()
    const exportUsersJob = createJob({
      name: 'export-users',
      pool: 'default',
      input: t.object({}),
      output: t.object({}),
    }).return()
    const plugin = defineJobs({
      client: createClientConfig(),
      pools: { default: { threads: 2, jobs: 5 } },
      jobs: async () => {
        calls.push({ type: 'jobs-factory' })
        return [importUsersJob]
      },
      hooks: async () => {
        calls.push({ type: 'hooks-factory' })
        return {
          added(event) {
            calls.push({ type: 'added', id: event.id, jobName: event.jobName })
          },
          updated(event) {
            calls.push({ type: 'updated', id: event.id, status: event.status })
          },
          removed(event) {
            calls.push({ type: 'removed', id: event.id })
          },
        }
      },
    })

    expect(plugin.name).toBe('jobs')
    expect(plugin.artifacts?.(createArtifactContext())).toEqual([
      expect.objectContaining({ id: 'job-runner', kind: 'worker' }),
    ])
    await resolveJobsConfig(plugin.jobsConfig)
    expect(calls).toEqual([{ type: 'jobs-factory' }, { type: 'hooks-factory' }])
    calls.length = 0

    const resolved = await resolveJobsConfig({
      client: createClientConfig(),
      pools: { default: { threads: 1, jobs: 1 } },
      jobs: () => [exportUsersJob],
      hooks: async () => ({
        added(event) {
          calls.push({ type: 'added', id: event.id, jobName: event.jobName })
        },
      }),
    })

    expect(resolved.jobs).toEqual([exportUsersJob])
    expect(Object.keys(resolved.hooks)).toEqual(['added'])

    await callJobsHook(resolved.hooks, 'added', createJobEvent({ id: '1' }))
    await callJobsHook(resolved.hooks, 'updated', createJobEvent({ id: '1' }))
    await callJobsHook(
      resolved.hooks,
      'removed',
      createRemovedEvent({ id: '1' }),
    )

    expect(calls).toEqual([{ type: 'added', id: '1', jobName: 'import-users' }])
  })

  it('isolates hook errors through the provided error handler', async () => {
    const errors: unknown[] = []
    await callJobsHook(
      {
        updated() {
          throw new Error('metadata write failed')
        },
      },
      'updated',
      createJobEvent({ id: '1' }),
      (error, event, hook) => {
        errors.push({
          hook,
          id: event.id,
          error: error instanceof Error ? error.message : String(error),
        })
      },
    )

    expect(errors).toEqual([
      { hook: 'updated', id: '1', error: 'metadata write failed' },
    ])
  })

  it('keeps CRUD-like hook payloads typed', () => {
    const hooks: JobsLifecycleHooks = {
      added(event) {
        expectTypeOf(event).toEqualTypeOf<JobsHookEvent>()
      },
      updated(event) {
        expectTypeOf(event).toEqualTypeOf<JobsHookEvent>()
      },
      removed(event) {
        expectTypeOf(event).toEqualTypeOf<JobsHookRemovedEvent>()
      },
    }

    const invalidHooks: JobsLifecycleHooks = {
      // @ts-expect-error added receives a full job snapshot event
      added(event: JobsHookRemovedEvent) {
        expect(Boolean(event)).toBe(true)
      },
    }

    expect(Object.keys(hooks)).toEqual(['added', 'updated', 'removed'])
    expect(Boolean(invalidHooks)).toBe(true)
  })

  it('exports app-facing job builders and injectables outside application', () => {
    const first = createStep({
      input: t.object({ name: t.string() }),
      output: t.object({ greeting: t.string() }),
      handler: (_ctx, input) => ({ greeting: `hello ${input.name}` }),
    })

    const job = createJob({
      name: 'greet-user',
      pool: 'default',
      input: t.object({ name: t.string() }),
      output: t.object({ greeting: t.string() }),
    })
      .step(first)
      .return()

    expect(job.name).toBe('greet-user')
    expect(job.jobSteps).toEqual([first])
    expect(jobManager.label).toBe('JobManager')
  })
})

function createPluginContext(): NeemPluginContext {
  return {
    mode: 'development',
    name: 'jobs',
    instanceId: 0,
    options: undefined,
    logger: createLogger({ pinoOptions: { enabled: false } }, 'test'),
    artifacts: { resolve: () => undefined, list: () => [] },
    workers: {
      spawn: async () => {
        throw new Error('unexpected worker spawn')
      },
      stop: async () => false,
      list: () => [],
    },
    hooks: {
      hook: () => () => {},
      hookOnce: () => () => {},
      addHooks: () => () => {},
    },
  }
}

function createArtifactContext() {
  return {
    mode: 'development' as const,
    name: 'jobs',
    instanceId: 0,
    options: undefined,
  }
}

function createClientConfig() {
  return () => ({}) as any
}

function createJobEvent(options: { id: string }): JobsHookEvent {
  return {
    id: options.id,
    jobName: 'import-users',
    queueName: 'nmtjs:jobs:import-users',
    status: 'pending',
    attempt: 0,
    updatedAt: Date.now(),
  }
}

function createRemovedEvent(options: { id: string }): JobsHookRemovedEvent {
  return {
    id: options.id,
    jobName: 'import-users',
    queueName: 'nmtjs:jobs:import-users',
    removedAt: Date.now(),
  }
}
