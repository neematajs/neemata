import { Container, provision, CoreInjectables } from '@nmtjs/core'
import { defineRuntimeWorker } from '@nmtjs/neem'

import type { WorkflowRuntimeAdapter } from '../runtime/client.ts'
import type {
  AnyTaskImplementation,
  AnyWorkflowImplementation,
  ResolvedWorkflowsConfig,
  WorkflowsConfig,
  WorkflowsWorkerData,
} from './runtime.ts'
import {
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
            role: ctx.data.role,
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

async function runRoleLoop(input: {
  readonly role: WorkflowsWorkerData['role']
  readonly runtime: WorkflowRuntimeAdapter
  readonly config: ResolvedWorkflowsConfig
  readonly container: Container
  readonly workerId: string
  readonly signal: AbortSignal
}): Promise<void> {
  while (!input.signal.aborted) {
    switch (input.role) {
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
        await sleep(
          input.config.workers.coordinator.pollIntervalMs,
          input.signal,
        )
        continue

      case 'activity':
        await runActivityWorker({
          ...input.runtime,
          container: input.container,
          workflows: input.config.workflows,
          activityNames: input.config.workers.activity.activityNames,
          workerId: input.workerId,
          concurrency: input.config.workers.activity.concurrency,
          leaseMs: input.config.workers.activity.leaseMs,
          maxIdleClaims: input.config.workers.activity.maxIdleClaims,
          idleDelayMs: input.config.workers.activity.pollIntervalMs,
          signal: input.signal,
        })
        await sleep(input.config.workers.activity.pollIntervalMs, input.signal)
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
        await sleep(input.config.workers.task.pollIntervalMs, input.signal)
        continue
    }
  }
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
