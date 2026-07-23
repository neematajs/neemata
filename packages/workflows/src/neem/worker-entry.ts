import type { Container } from '@nmtjs/core'
import {
  ExecutionEnvironment,
  ExecutionEnvironmentLifecycleHook,
} from '@nmtjs/core'
import { defineRuntimeWorker } from '@nmtjs/neem'

import type { WorkflowRuntimeAdapter } from '../runtime/client.ts'
import type {
  AnyTaskImplementation,
  AnyWorkflowImplementation,
  ResolvedExecutionWorkerPool,
  ResolvedWorkflowsConfig,
  WorkflowsConfig,
  WorkflowsWorkerData,
} from './runtime.ts'
import { serveExecutionWorker, serveWorkflowWorker } from '../runtime/worker.ts'
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
      let workerLoop: Promise<void> | undefined
      let runtime: WorkflowRuntimeAdapter | undefined
      let execution: ExecutionEnvironment | undefined
      let resolveFinished!: () => void
      let rejectFinished!: (error: unknown) => void
      const finished = new Promise<void>((resolve, reject) => {
        resolveFinished = resolve
        rejectFinished = reject
      })
      // Older hosts may not observe the lifecycle promise.
      void finished.catch(() => {})

      return {
        finished,
        async start() {
          const config = await resolveWorkflowsConfig(ctx.definition)
          const executionPool =
            ctx.data.role === 'execution'
              ? resolveExecutionWorkerPool(config, ctx.data)
              : undefined
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
          if (ctx.data.role === 'coordinator' && config.schedules.length > 0) {
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
            data: ctx.data,
            runtime,
            config,
            executionPool,
            container: execution.container,
            workerId: ctx.name,
            signal: abort.signal,
          })
          workerLoop.then(resolveFinished, (error: unknown) => {
            ctx.logger.error(
              { err: error },
              'Neem workflows worker loop failed',
            )
            rejectFinished(error)
          })
          await execution.lifecycleHooks.callHook(
            ExecutionEnvironmentLifecycleHook.Start,
          )
        },
        async stop() {
          abort.abort()
          let failure: unknown
          const attempt = async (operation: () => unknown) => {
            try {
              await operation()
            } catch (error) {
              failure ??= error
            }
          }

          await attempt(async () => await workerLoop)
          if (workerLoop) {
            await attempt(async () => {
              await execution?.lifecycleHooks.callHook(
                ExecutionEnvironmentLifecycleHook.Stop,
              )
            })
          }
          if (execution) {
            await attempt(async () => {
              await execution?.lifecycleHooks.callHook(
                ExecutionEnvironmentLifecycleHook.BeforeDispose,
                execution,
              )
            })
          }
          await attempt(async () => await runtime?.dispose?.())
          if (execution) {
            await attempt(async () => {
              await execution?.lifecycleHooks.callHook(
                ExecutionEnvironmentLifecycleHook.AfterDispose,
                execution,
              )
            })
            await attempt(async () => await execution?.dispose())
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
  readonly data: WorkflowsWorkerData
  readonly runtime: WorkflowRuntimeAdapter
  readonly config: ResolvedWorkflowsConfig
  readonly executionPool?: ResolvedExecutionWorkerPool
  readonly container: Container
  readonly workerId: string
  readonly signal: AbortSignal
}): Promise<void> {
  const role = input.data.role
  switch (role) {
    case 'coordinator':
      await serveWorkflowWorker({
        ...input.runtime,
        container: input.container,
        workflows: input.config.workflows,
        workerId: input.workerId,
        concurrency: input.config.workers.coordinator.concurrency,
        leaseMs: input.config.workers.coordinator.leaseMs,
        idleDelayMs: input.config.workers.coordinator.pollIntervalMs,
        scheduling:
          input.config.schedules.length === 0 ? undefined : { everyMs: 1000 },
        signal: input.signal,
      })
      return

    case 'execution':
      await serveExecutionWorker({
        ...input.runtime,
        container: input.container,
        workflows: input.config.workflows,
        tasks: input.config.tasks,
        activityNames: input.executionPool!.activityNames,
        taskNames: input.executionPool!.taskNames,
        workerId: input.workerId,
        concurrency: input.executionPool!.concurrency,
        leaseMs: input.executionPool!.leaseMs,
        idleDelayMs: input.executionPool!.pollIntervalMs,
        // Coordinators own maintenance so execution capacity is not duplicated
        // across every named pool and thread.
        reaping: false,
        signal: input.signal,
      })
      return
  }
}

export function resolveExecutionWorkerPool(
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
