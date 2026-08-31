import type {
  NeemRuntime,
  NeemRuntimeHmrAdapter,
  NeemRuntimeWorker,
  NeemRuntimeWorkerContext,
} from '@nmtjs/neem'
import { createFuture } from '@nmtjs/common'

import type { WorkflowsWorkerData } from './runtime.ts'
import type { WorkflowsWorkerConfig } from './worker-entry.ts'

type WorkflowsRuntimeWorker = NeemRuntimeWorker<
  WorkflowsWorkerData,
  WorkflowsWorkerConfig
>
type WorkflowsRuntimeContext = NeemRuntimeWorkerContext<
  WorkflowsWorkerData,
  WorkflowsWorkerConfig
>

class ReloadableWorkflowsRuntime implements NeemRuntime {
  readonly finished: Promise<void>
  private readonly finish
  private current: NeemRuntime
  private context: WorkflowsRuntimeContext
  private replacing = false
  private stopped = false

  private constructor(runtime: NeemRuntime, context: WorkflowsRuntimeContext) {
    this.current = runtime
    this.context = context
    this.finish = createFuture<void>()
    this.finished = this.finish.promise
    void this.finished.catch(() => {})
  }

  static async create(
    worker: WorkflowsRuntimeWorker,
    context: WorkflowsRuntimeContext,
  ): Promise<ReloadableWorkflowsRuntime> {
    return new ReloadableWorkflowsRuntime(
      await worker.createRuntime(context),
      context,
    )
  }

  async start() {
    const upstreams = await this.current.start()
    this.watch(this.current)
    return upstreams
  }

  async apply(next: WorkflowsRuntimeWorker): Promise<void> {
    this.replacing = true
    try {
      await this.current.stop()
      const nextContext = { ...this.context, definition: next.definition }
      const replacement = await next.createRuntime(nextContext)
      try {
        const upstreams = await replacement.start()
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

      this.current = replacement
      this.context = nextContext
      this.watch(replacement)
    } finally {
      this.replacing = false
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    try {
      await this.current.stop()
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
    return !this.stopped && !this.replacing && this.current === runtime
  }
}

export const workflowsHmrAdapter: NeemRuntimeHmrAdapter<
  WorkflowsWorkerData,
  WorkflowsWorkerConfig
> = {
  createRuntime(worker, ctx) {
    return ReloadableWorkflowsRuntime.create(worker, ctx)
  },
  async apply(runtime, _current, next) {
    if (!(runtime instanceof ReloadableWorkflowsRuntime)) {
      return {
        accepted: false,
        reason: 'Workflows runtime was not created by its HMR adapter',
      }
    }
    await runtime.apply(next)
    return { accepted: true }
  },
}
