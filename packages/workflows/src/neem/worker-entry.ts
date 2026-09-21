import type { NeemRuntimeWorkerContext } from '@nmtjs/neem'
import { createFuture } from '@nmtjs/common'
import { defineRuntimeWorker } from '@nmtjs/neem'

import type { Env } from '../implement/index.ts'
import type { WorkflowRuntimeAdapter } from '../runtime/client.ts'
import type { AnyScheduleDefinition, MaybePromise } from '../types/index.ts'
import type {
  AnyTaskImplementation,
  AnyWorkflowImplementation,
  WorkflowsRegistry,
  WorkflowsWorkerData,
} from './runtime.ts'
import {
  createHandlerRunner,
  WorkflowCleanupTimeoutError,
} from '../runtime/handler.ts'
import { resolveWorkerSettings, resolveWorkflowsRegistry } from './runtime.ts'
import { runRoleLoop } from './serve.ts'

// A stop during startup ends initialization without being a failure.
class WorkerStopped extends Error {
  constructor() {
    super('Workflows worker stopped')
  }
}

/** What one worker thread owns: the adapter, the handlers' env and its disposal. */
export type WorkflowsWorkerResources<E> = {
  readonly runtime: WorkflowRuntimeAdapter
  /** Runs after the loops have stopped and every handler has settled. */
  readonly dispose?: () => MaybePromise<void>
} & (unknown extends E ? { readonly env?: E } : { readonly env: E })

export type WorkflowsWorkerDefinition<
  W extends AnyWorkflowImplementation = AnyWorkflowImplementation,
  T extends AnyTaskImplementation = AnyTaskImplementation,
> = WorkflowsRegistry<W, T, AnyScheduleDefinition> & {
  /** Runs once per worker thread; `ctx.data` names its role and pool. */
  readonly setup: (
    ctx: NeemRuntimeWorkerContext<WorkflowsWorkerData, unknown>,
  ) => MaybePromise<WorkflowsWorkerResources<NoInfer<Env<W | T>>>>
}

export function defineWorkflowsWorker<
  const W extends AnyWorkflowImplementation = never,
  const T extends AnyTaskImplementation = never,
>(definition: WorkflowsWorkerDefinition<W, T>) {
  return defineRuntimeWorker<WorkflowsWorkerData, unknown>({
    definition,
    // Production builds erase this branch and its adapter import.
    ...((import.meta as ImportMeta & { readonly hot?: unknown }).hot
      ? {
          async hmr() {
            const { hmrAdapter } = await import('./hmr.ts')
            return hmrAdapter
          },
        }
      : {}),
    createRuntime(ctx) {
      const abort = new AbortController()
      const ready = createFuture<undefined>()
      const finished = createFuture<void>()
      void ready.promise.catch(() => {})
      void finished.promise.catch(() => {})
      let start: Promise<undefined> | undefined
      let stop: Promise<void> | undefined
      let stopping = false
      let initialization: Promise<void> | undefined
      let cleanup: (() => Promise<void>) | undefined
      let failure: { readonly error: unknown } | undefined

      const fail = (error: unknown) => {
        failure ??= { error }
        ready.reject(error)
        finished.reject(error)
      }

      async function initialize() {
        const registry = await resolveWorkflowsRegistry(definition, ctx.data)
        const settings = resolveWorkerSettings(ctx.data.settings)
        const timeoutMs = settings.cleanupTimeoutMs
        if (stopping) throw new WorkerStopped()
        const resources = await definition.setup(ctx)
        const handlers = createHandlerRunner({
          cleanupTimeoutMs: timeoutMs,
          // finished is observed by Neem before cleanup completes. An overrun
          // requires thread recycling, not disposal of an env still in use.
          onFatal: (error) => {
            abort.abort(error)
            fail(error)
          },
        })
        // Cleanup can run before the loop exists, when a later startup step fails.
        const serving: { loop?: Promise<void> } = {}
        let cleaning: Promise<void> | undefined
        cleanup = () =>
          (cleaning ??= (async () => {
            abort.abort()
            // Keep the deadline armed through adapter and env disposal, so a
            // failed worker cannot hang in cleanup while appearing live.
            const timer = setTimeout(
              () => fail(new WorkflowCleanupTimeoutError(timeoutMs)),
              timeoutMs,
            )
            try {
              // Stop claims and abort attempts, then join engine work before
              // draining handlers: an execution awaiting storage may register one.
              await serving.loop?.catch(() => {})
              await handlers.drain()
              // A failing adapter disposer must not leak what the env holds.
              try {
                await resources.runtime.dispose?.()
              } finally {
                await resources.dispose?.()
              }
            } finally {
              clearTimeout(timer)
            }
          })())
        // A stop that arrived during setup still owns what setup acquired.
        if (stopping) throw new WorkerStopped()

        if (ctx.data.role === 'coordinator' && registry.schedules.length > 0) {
          if (!resources.runtime.scheduler)
            throw new Error(
              'Workflow runtime adapter does not support schedules',
            )
          await resources.runtime.scheduler.reconcile(registry.schedules)
        }
        if (stopping) throw new WorkerStopped()
        serving.loop = runRoleLoop({
          data: ctx.data,
          settings,
          runtime: resources.runtime,
          registry,
          handlers,
          env: resources.env,
          workerId: ctx.name,
          signal: abort.signal,
          onError: (error) =>
            ctx.logger.error({ err: error }, 'Neem workflows worker error'),
        })
        // Any exit before a stop is a failure, as is a loop error at any time.
        // Registered before cleanup joins the loop, so `failure` is set first.
        void serving.loop.then(
          () => {
            if (stopping) return
            fail(
              new Error('Workflows worker finished before stop was requested'),
            )
            void cleanup!().catch(() => {})
          },
          (error: unknown) => {
            ctx.logger.error(
              { err: error },
              'Neem workflows worker loop failed',
            )
            fail(error)
            void cleanup!().catch(() => {})
          },
        )
        ready.resolve(undefined)
      }

      return {
        finished: finished.promise,
        start() {
          if (stopping)
            return Promise.reject(new Error('Workflows worker stopped'))
          if (start) return start
          // Memoize before asynchronous definition resolution can yield.
          start = ready.promise
          initialization = initialize().catch(async (error: unknown) => {
            // Setup may have succeeded before a later step failed.
            await cleanup?.().catch(() => {})
            if (!(error instanceof WorkerStopped)) fail(error)
          })
          return start
        },
        stop() {
          if (stop) return stop
          stopping = true
          abort.abort()
          ready.reject(new Error('Workflows worker stopped before readiness'))
          stop = (async () => {
            // Setup cannot be interrupted; what it acquired must be disposed.
            await initialization
            try {
              await cleanup?.()
            } catch (error) {
              fail(error)
            }
            if (failure) throw failure.error
            finished.resolve()
          })()
          return stop
        },
      }
    },
  })
}
