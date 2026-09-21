import type {
  NeemRuntime,
  NeemRuntimeHmrAdapter,
  NeemRuntimeWorker,
  NeemRuntimeWorkerContext,
} from '@nmtjs/neem'
import { createFuture } from '@nmtjs/common'

import type { WorkflowsWorkerData } from './runtime.ts'

type Worker = NeemRuntimeWorker<WorkflowsWorkerData, unknown>
type WorkerContext = NeemRuntimeWorkerContext<WorkflowsWorkerData, unknown>

class ReloadableRuntime implements NeemRuntime {
  readonly finished: Promise<void>
  private readonly finish
  private current: NeemRuntime
  private context: WorkerContext
  private retiring: NeemRuntime | undefined
  private replacing: Promise<void> | undefined
  private stopping: Promise<void> | undefined
  private stopped = false

  private constructor(runtime: NeemRuntime, context: WorkerContext) {
    this.current = runtime
    this.context = context
    this.finish = createFuture<void>()
    this.finished = this.finish.promise
    void this.finished.catch(() => {})
  }

  static async create(
    worker: Worker,
    context: WorkerContext,
  ): Promise<ReloadableRuntime> {
    return new ReloadableRuntime(await worker.createRuntime(context), context)
  }

  async start() {
    if (this.stopped) throw new Error('Workflows runtime stopped')
    const upstreams = await this.current.start()
    this.watch(this.current)
    return upstreams
  }

  async apply(next: Worker): Promise<void> {
    if (this.stopped) throw new Error('Workflows runtime stopped')
    if (this.replacing)
      throw new Error('Workflows runtime is already reloading')
    this.replacing = this.replace(next)
    try {
      await this.replacing
    } finally {
      this.replacing = undefined
    }
  }

  private async replace(next: Worker): Promise<void> {
    // The old generation's expected completion must not finish the Neem worker.
    this.retiring = this.current
    await this.current.stop()
    if (this.stopped) throw new Error('Workflows runtime stopped')

    const context = { ...this.context, definition: next.definition }
    const replacement = await next.createRuntime(context)
    // Publish before start so a concurrent stop can interrupt pending readiness.
    this.current = replacement
    this.context = context
    try {
      if (this.stopped) throw new Error('Workflows runtime stopped')
      const upstreams = await replacement.start()
      if (this.stopped) throw new Error('Workflows runtime stopped')
      if (upstreams?.length) {
        throw new Error(
          'Workflow HMR cannot change runtime upstreams without a full reload',
        )
      }
    } catch (error) {
      try {
        await replacement.stop()
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Failed to reload workflows and clean up the replacement generation',
        )
      }
      throw error
    }

    this.retiring = undefined
    this.watch(replacement)
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopped = true
    return (this.stopping = this.stopCurrent())
  }

  private async stopCurrent(): Promise<void> {
    try {
      await this.current.stop()
      // A factory already in flight still owns any resources it acquires.
      await this.replacing?.catch(() => {})
      this.finish.resolve()
    } catch (error) {
      this.finish.reject(error)
      throw error
    }
  }

  private watch(runtime: NeemRuntime): void {
    if (!runtime.finished) return
    void Promise.resolve(runtime.finished).then(
      () => {
        if (this.isCurrentUnexpectedCompletion(runtime)) {
          this.finish.reject(
            new Error(
              'Neem workflows runtime finished before stop was requested',
            ),
          )
        }
      },
      (error: unknown) => {
        if (this.isCurrentUnexpectedCompletion(runtime)) {
          this.finish.reject(error)
        }
      },
    )
  }

  private isCurrentUnexpectedCompletion(runtime: NeemRuntime): boolean {
    return (
      !this.stopped && this.retiring !== runtime && this.current === runtime
    )
  }
}

export const hmrAdapter: NeemRuntimeHmrAdapter<WorkflowsWorkerData, unknown> = {
  createRuntime(worker, ctx) {
    return ReloadableRuntime.create(worker, ctx)
  },
  async apply(runtime, _current, next) {
    if (!(runtime instanceof ReloadableRuntime)) {
      return {
        accepted: false,
        reason: 'Workflows runtime was not created by its HMR adapter',
      }
    }
    await runtime.apply(next)
    return { accepted: true }
  },
}
