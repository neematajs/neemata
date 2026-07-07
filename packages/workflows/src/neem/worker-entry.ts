import { Container, provision, CoreInjectables } from '@nmtjs/core'
import { defineRuntimeWorker } from '@nmtjs/neem'

import type { WorkflowRuntimeAdapter } from '../runtime/client.ts'
import type {
  AnyTaskImplementation,
  AnyWorkflowImplementation,
  ResolvedActivityWorkerPool,
  ResolvedWorkflowsConfig,
  WorkflowsConfig,
  WorkflowsWorkerData,
} from './runtime.ts'
import {
  collectWorkflowActivityNames,
  runActivityWorker,
  runTaskWorker,
  runWorkflowWorker,
} from '../runtime/worker.ts'
import { resolveWorkflowsConfig } from './runtime.ts'

export type WorkflowsWorkerConfig<
  TWorkflowImplementation extends AnyWorkflowImplementation =
    AnyWorkflowImplementation,
  TTaskImplementation extends AnyTaskImplementation = AnyTaskImplementation,
> = WorkflowsConfig<TWorkflowImplementation, TTaskImplementation>

export function defineWorkflowsWorker<
  const TWorkflowImplementation extends AnyWorkflowImplementation,
  const TTaskImplementation extends AnyTaskImplementation =
    AnyTaskImplementation,
>(config: WorkflowsWorkerConfig<TWorkflowImplementation, TTaskImplementation>) {
  return defineRuntimeWorker<WorkflowsWorkerData, WorkflowsWorkerConfig>({
    definition: config,
    createRuntime(ctx) {
      const abort = new AbortController()
      const container = new Container({ logger: ctx.logger })
      let workerLoop: Promise<void> | undefined
      let workerLoopError: unknown
      let runtime: WorkflowRuntimeAdapter | undefined

      container.provide([provision(CoreInjectables.logger, ctx.logger)])

      return {
        async start() {
          const config = await resolveWorkflowsConfig(ctx.definition)
          runtime = await config.runtime()
          if (ctx.data.role === 'coordinator' && config.schedules.length > 0) {
            if (!runtime.scheduler) {
              throw new Error(
                'Workflow runtime adapter does not support schedules',
              )
            }
            await runtime.scheduler.reconcile(config.schedules)
          }
          workerLoopError = undefined
          workerLoop = runRoleLoop({
            data: ctx.data,
            runtime,
            config,
            container,
            workerId: ctx.name,
            signal: abort.signal,
          }).catch((error: unknown) => {
            workerLoopError = error
            ctx.logger.error(
              { err: error },
              'Neem workflows worker loop failed',
            )
            throw error
          })
          void workerLoop.catch(() => {})
        },
        async stop() {
          abort.abort()
          try {
            await workerLoop
          } catch (error) {
            workerLoopError ??= error
          }
          await runtime?.dispose?.()
          workerLoop = undefined
          runtime = undefined
          if (workerLoopError) throw workerLoopError
        },
      }
    },
  })
}

const ROLE_WAKE_KIND = {
  coordinator: 'continue',
  activity: 'activity',
  task: 'task',
} as const

async function runRoleLoop(input: {
  readonly data: WorkflowsWorkerData
  readonly runtime: WorkflowRuntimeAdapter
  readonly config: ResolvedWorkflowsConfig
  readonly container: Container
  readonly workerId: string
  readonly signal: AbortSignal
}): Promise<void> {
  const role = input.data.role
  const activityPool =
    role === 'activity'
      ? resolveActivityWorkerPool(input.config, input.data)
      : undefined
  const activityNames =
    activityPool === undefined
      ? undefined
      : resolveActivityPoolClaimNames(
          activityPool,
          input.config.workers.activity,
          input.config.workflows,
        )
  // Between loop iterations the poll-interval sleep races the adapter's wake
  // hint (if any), so a fresh command interrupts idle waiting immediately.
  const idleSleep = async (ms: number) => {
    const wakeEvents = input.runtime.wakeEvents
    if (!wakeEvents) return sleep(ms, input.signal)
    let unsubscribe = () => {}
    const woken = new Promise<void>((resolve) => {
      unsubscribe = wakeEvents.onCommand(ROLE_WAKE_KIND[role], resolve)
    })
    try {
      await Promise.race([sleep(ms, input.signal), woken])
    } finally {
      unsubscribe()
    }
  }

  while (!input.signal.aborted) {
    switch (role) {
      case 'coordinator':
        await runWorkflowWorker({
          ...input.runtime,
          container: input.container,
          workflows: input.config.workflows,
          workerId: input.workerId,
          concurrency: input.config.workers.coordinator.concurrency,
          leaseMs: input.config.workers.coordinator.leaseMs,
          maxIdleClaims: input.config.workers.coordinator.maxIdleClaims,
          idleDelayMs: input.config.workers.coordinator.pollIntervalMs,
          scheduling:
            input.config.schedules.length === 0 ? undefined : { everyMs: 1000 },
          signal: input.signal,
        })
        await idleSleep(input.config.workers.coordinator.pollIntervalMs)
        continue

      case 'activity':
        await runActivityWorker({
          ...input.runtime,
          container: input.container,
          workflows: input.config.workflows,
          activityNames,
          workerId: input.workerId,
          concurrency: activityPool!.concurrency,
          leaseMs: activityPool!.leaseMs,
          maxIdleClaims: activityPool!.maxIdleClaims,
          idleDelayMs: activityPool!.pollIntervalMs,
          signal: input.signal,
        })
        await idleSleep(activityPool!.pollIntervalMs)
        continue

      case 'task':
        await runTaskWorker({
          ...input.runtime,
          container: input.container,
          tasks: input.config.tasks,
          workerId: input.workerId,
          concurrency: input.config.workers.task.concurrency,
          leaseMs: input.config.workers.task.leaseMs,
          maxIdleClaims: input.config.workers.task.maxIdleClaims,
          idleDelayMs: input.config.workers.task.pollIntervalMs,
          signal: input.signal,
        })
        await idleSleep(input.config.workers.task.pollIntervalMs)
        continue
    }
  }
}

function resolveActivityWorkerPool(
  config: ResolvedWorkflowsConfig,
  data: WorkflowsWorkerData,
): ResolvedActivityWorkerPool {
  const pools = config.workers.activity
  if (data.activityPool !== undefined) {
    const pool = pools.find((candidate) => candidate.name === data.activityPool)
    if (!pool) {
      throw new Error(
        `Unknown workflows activity worker pool [${data.activityPool}]`,
      )
    }
    return pool
  }
  // worker data without a pool name (hand-written neem config) is only
  // unambiguous when a single pool exists
  if (pools.length === 1) return pools[0]!
  throw new Error(
    'Workflows activity worker data must name a pool when multiple activity pools are configured',
  )
}

// A catch-all pool must not claim activities selected by sibling pools, or
// capacity isolation silently breaks; explicit pools claim their list as-is.
export function resolveActivityPoolClaimNames(
  pool: ResolvedActivityWorkerPool,
  pools: readonly ResolvedActivityWorkerPool[],
  workflows: ResolvedWorkflowsConfig['workflows'],
): readonly string[] | undefined {
  if (pool.activityNames !== undefined) return pool.activityNames
  const claimedElsewhere = new Set(
    pools.flatMap((sibling) =>
      sibling.name === pool.name ? [] : (sibling.activityNames ?? []),
    ),
  )
  if (claimedElsewhere.size === 0) return undefined
  return collectWorkflowActivityNames(workflows).filter(
    (name) => !claimedElsewhere.has(name),
  )
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return

  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timeout = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}
