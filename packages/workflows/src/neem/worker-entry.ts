import { Container, provision, CoreInjectables } from '@nmtjs/core'
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
      const container = new Container({ logger: ctx.logger })
      let workerLoop: Promise<void> | undefined
      let runtime: WorkflowRuntimeAdapter | undefined
      let resolveFinished!: () => void
      let rejectFinished!: (error: unknown) => void
      const finished = new Promise<void>((resolve, reject) => {
        resolveFinished = resolve
        rejectFinished = reject
      })
      // Older hosts may not observe the lifecycle promise.
      void finished.catch(() => {})

      container.provide([provision(CoreInjectables.logger, ctx.logger)])

      return {
        finished,
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
          workerLoop = runRoleLoop({
            data: ctx.data,
            runtime,
            config,
            container,
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
        },
        async stop() {
          abort.abort()
          let workerLoopFailed = false
          let workerLoopError: unknown
          try {
            await workerLoop
          } catch (error) {
            workerLoopFailed = true
            workerLoopError = error
          }
          await runtime?.dispose?.()
          workerLoop = undefined
          runtime = undefined
          if (workerLoopFailed) throw workerLoopError
        },
      }
    },
  })
}

async function runRoleLoop(input: {
  readonly data: WorkflowsWorkerData
  readonly runtime: WorkflowRuntimeAdapter
  readonly config: ResolvedWorkflowsConfig
  readonly container: Container
  readonly workerId: string
  readonly signal: AbortSignal
}): Promise<void> {
  const role = input.data.role
  const executionPool =
    role === 'execution'
      ? resolveExecutionWorkerPool(input.config, input.data)
      : undefined
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
        activityNames: executionPool!.activityNames,
        taskNames: executionPool!.taskNames,
        workerId: input.workerId,
        concurrency: executionPool!.concurrency,
        leaseMs: executionPool!.leaseMs,
        idleDelayMs: executionPool!.pollIntervalMs,
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
