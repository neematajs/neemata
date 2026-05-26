import type {
  JobRunnerRunOptions,
  JobsClient,
  JobsHookEvent,
  JobsHookRemovedEvent,
  JobsLifecycleHooks,
  SaveProgressContext,
} from '@nmtjs/jobs'
import { LifecycleHook, LifecycleHooks } from '@nmtjs/application'
import { Container, createLogger } from '@nmtjs/core'
import {
  callJobsHook,
  createJob,
  createStep,
  JobRunner,
  jobAbortSignal,
  jobManager,
} from '@nmtjs/jobs'
import {
  defineJobs,
  resolveJobsConfig,
  resolveJobsWorkerConfig,
} from '@nmtjs/jobs/neem'
import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it } from 'vitest'

describe('@nmtjs/jobs Neem contracts', () => {
  it('defines jobs runtime config from async jobs and hook factories', async () => {
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
    const config = defineJobs({
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
      schedules: async () => {
        calls.push({ type: 'schedules-factory' })
        return [
          {
            id: 'import-users-hourly',
            job: importUsersJob,
            data: {},
            repeat: { every: 60 * 60 * 1000 },
          },
        ]
      },
    })

    expect(config.pools.default).toEqual({ threads: 2, jobs: 5 })
    await resolveJobsConfig(config)
    expect(calls).toEqual([
      { type: 'jobs-factory' },
      { type: 'hooks-factory' },
      { type: 'schedules-factory' },
    ])
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
    expect(resolved.schedules).toEqual([])

    await callJobsHook(resolved.hooks, 'added', createJobEvent({ id: '1' }))
    await callJobsHook(resolved.hooks, 'updated', createJobEvent({ id: '1' }))
    await callJobsHook(
      resolved.hooks,
      'removed',
      createRemovedEvent({ id: '1' }),
    )

    expect(calls).toEqual([{ type: 'added', id: '1', jobName: 'import-users' }])
  })

  it('does not resolve lifecycle hooks in runner worker config', async () => {
    const calls: unknown[] = []
    const job = createJob({
      name: 'worker-only',
      pool: 'default',
      input: t.object({}),
      output: t.object({}),
    }).return()

    const resolved = await resolveJobsWorkerConfig({
      client: createClientConfig(),
      pools: { default: { threads: 1, jobs: 1 } },
      jobs: async () => {
        calls.push({ type: 'jobs-factory' })
        return [job]
      },
      hooks: async () => {
        calls.push({ type: 'hooks-factory' })
        return {}
      },
      schedules: async () => {
        calls.push({ type: 'schedules-factory' })
        return []
      },
    })

    expect(resolved.jobs).toEqual([job])
    expect(calls).toEqual([{ type: 'jobs-factory' }])
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

  it('aborts running jobs when lifecycle dispose hook fires', async () => {
    let aborted = false
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    const container = new Container({ logger })
    const lifecycleHooks = new LifecycleHooks()
    const step = createStep({
      input: t.object({}),
      output: t.object({}),
      dependencies: { signal: jobAbortSignal },
      handler({ signal }) {
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('job aborted'))
          })
        })
      },
    })
    const job = createJob({
      name: 'abort-on-dispose',
      pool: 'default',
      input: t.object({}),
      output: t.object({}),
    })
      .step(step)
      .return()
    const runner = new TestJobRunner({ logger, container, lifecycleHooks })

    const running = runner.runJob(
      job,
      {},
      { signal: new AbortController().signal },
    )
    await wait(10)
    await lifecycleHooks.callHook(LifecycleHook.BeforeDispose, {
      logger,
      container,
    })

    await expect(running).rejects.toThrow('Error during step [0]')
    expect(aborted).toBe(true)
  })
})

class TestJobRunner extends JobRunner {
  protected createSaveProgressFn(
    _context: SaveProgressContext<JobRunnerRunOptions>,
  ) {
    return async () => {}
  }
}

function createClientConfig() {
  return (() => ({})) as JobsClient
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
