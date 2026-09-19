import type { Container } from '@nmtjs/core'
import { createFuture } from '@nmtjs/common'
import {
  ExecutionEnvironment,
  ExecutionEnvironmentLifecycleHook,
} from '@nmtjs/core'
import { defineRuntimeWorker } from '@nmtjs/neem'

import type {
  AnyTaskImplementation,
  AnyWorkflowImplementation,
} from '../implement/index.ts'
import type { WorkflowRuntimeAdapter } from '../runtime/client.ts'
import type {
  ResolvedExecutionWorkerPool,
  ResolvedWorkflowsConfig,
  WorkflowsConfig,
  WorkflowsWorkerData,
} from './runtime.ts'
import { serveExecutionWorker, serveWorkflowWorker } from '../runtime/worker.ts'
import { resolveWorkflowsConfig } from './runtime.ts'

/** How often a coordinator sweeps due schedules. */
const SCHEDULE_TICK_MS = 1_000

type WorkerRole =
  | { readonly role: 'coordinator' }
  | { readonly role: 'execution'; readonly pool: ResolvedExecutionWorkerPool }

export function defineWorkflowsWorker<
  const TWorkflowImplementation extends AnyWorkflowImplementation,
  const TTaskImplementation extends AnyTaskImplementation =
    AnyTaskImplementation,
>(config: WorkflowsConfig<TWorkflowImplementation, TTaskImplementation>) {
  return defineRuntimeWorker<WorkflowsWorkerData, WorkflowsConfig>({
    definition: config,
    createRuntime(ctx) {
      const abort = new AbortController()
      let workerLoop: Promise<void> | undefined
      let runtime: WorkflowRuntimeAdapter | undefined
      let execution: ExecutionEnvironment | undefined
      const finished = createFuture<void>()
      // Older hosts may not observe the lifecycle promise.
      void finished.promise.catch(() => {})

      return {
        finished: finished.promise,
        async start() {
          const config = await resolveWorkflowsConfig(ctx.definition)
          const role: WorkerRole =
            ctx.data.role === 'execution'
              ? {
                  role: 'execution',
                  pool: resolveExecutionWorkerPool(config, ctx.data),
                }
              : { role: 'coordinator' }
          execution = new ExecutionEnvironment({
            logger: ctx.logger,
            label: 'Workflows',
            plugins: config.plugins,
          })
          await execution.initialize()
          await execution.lifecycleHooks.callHook(
            ExecutionEnvironmentLifecycleHook.BeforeInitialize,
            execution,
          )
          runtime = await config.runtime()
          if (role.role === 'coordinator' && config.schedules.length > 0) {
            if (!runtime.scheduler) {
              throw new Error(
                'Workflow runtime adapter does not support schedules',
              )
            }
            await runtime.scheduler.reconcile(config.schedules)
          }
          await execution.lifecycleHooks.callHook(
            ExecutionEnvironmentLifecycleHook.AfterInitialize,
            execution,
          )
          workerLoop = runRoleLoop({
            role,
            runtime,
            config,
            container: execution.container,
            workerId: ctx.name,
            signal: abort.signal,
            onError: (error) =>
              ctx.logger.error({ err: error }, 'Neem workflows worker error'),
          })
          workerLoop.then(finished.resolve, (error: unknown) => {
            ctx.logger.error(
              { err: error },
              'Neem workflows worker loop failed',
            )
            finished.reject(error)
          })
          await execution.lifecycleHooks.callHook(
            ExecutionEnvironmentLifecycleHook.Start,
          )
        },
        async stop() {
          abort.abort()
          const loop = workerLoop
          const env = execution
          const adapter = runtime
          const steps: Array<() => unknown> = [() => loop]

          if (loop && env) {
            steps.push(() =>
              env.lifecycleHooks.callHook(
                ExecutionEnvironmentLifecycleHook.Stop,
              ),
            )
          }
          if (env) {
            steps.push(() =>
              env.lifecycleHooks.callHook(
                ExecutionEnvironmentLifecycleHook.BeforeDispose,
                env,
              ),
            )
          }
          steps.push(() => adapter?.dispose?.())
          if (env) {
            steps.push(
              () =>
                env.lifecycleHooks.callHook(
                  ExecutionEnvironmentLifecycleHook.AfterDispose,
                  env,
                ),
              () => env.dispose(),
            )
          }

          // Every step runs even when an earlier one fails; the first failure
          // is what the host is told about.
          let failure: unknown
          for (const step of steps) {
            try {
              await step()
            } catch (error) {
              failure ??= error
            }
          }

          workerLoop = undefined
          runtime = undefined
          execution = undefined
          if (failure) throw failure
        },
      }
    },
  })
}

async function runRoleLoop(input: {
  readonly role: WorkerRole
  readonly runtime: WorkflowRuntimeAdapter
  readonly config: ResolvedWorkflowsConfig
  readonly container: Container
  readonly workerId: string
  readonly signal: AbortSignal
  readonly onError: (error: unknown) => void
}): Promise<void> {
  const { role, runtime, config, container, workerId, signal, onError } = input

  if (role.role === 'coordinator') {
    const { coordinator } = config.workers
    await serveWorkflowWorker({
      ...runtime,
      container,
      workflows: config.workflows,
      workerId,
      concurrency: coordinator.concurrency,
      leaseMs: coordinator.leaseMs,
      idleDelayMs: coordinator.pollIntervalMs,
      scheduling:
        config.schedules.length === 0
          ? undefined
          : { everyMs: SCHEDULE_TICK_MS },
      signal,
      onError,
    })
    return
  }

  const { pool } = role
  await serveExecutionWorker({
    ...runtime,
    container,
    workflows: config.workflows,
    tasks: config.tasks,
    activityNames: pool.activityNames,
    taskNames: pool.taskNames,
    workerId,
    concurrency: pool.concurrency,
    leaseMs: pool.leaseMs,
    idleDelayMs: pool.pollIntervalMs,
    // Coordinators own maintenance so execution capacity is not duplicated
    // across every named pool and thread.
    reaping: false,
    signal,
    onError,
  })
}

function resolveExecutionWorkerPool(
  config: ResolvedWorkflowsConfig,
  data: WorkflowsWorkerData,
): ResolvedExecutionWorkerPool {
  const pools = config.workers.execution
  if (data.pool !== undefined) {
    const pool = pools.find((candidate) => candidate.name === data.pool)
    if (!pool) {
      throw new Error(`Unknown workflows execution worker pool [${data.pool}]`)
    }
    return pool
  }
  // Hand-written worker data can omit a name only when routing is unambiguous.
  if (pools.length === 1) return pools[0]!
  throw new Error(
    'Workflows execution worker data must name a pool when multiple execution pools are configured',
  )
}
