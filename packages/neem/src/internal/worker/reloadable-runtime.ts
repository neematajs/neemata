import { isDeepStrictEqual } from 'node:util'

import { createFuture } from '@nmtjs/common'

import type {
  NeemRuntime,
  NeemRuntimeWorker,
  NeemRuntimeWorkerContext,
  NeemRuntimeUpstream,
} from '../../shared/types.ts'
import { parseRuntimeStartResult } from '../schemas/runtime.ts'
import { normalizeError } from '../utils.ts'

type Worker = NeemRuntimeWorker
type WorkerContext = NeemRuntimeWorkerContext

export type GenerationReload =
  | { outcome: 'applied' }
  // The current generation was not touched and keeps serving.
  | { outcome: 'rejected'; error: Error }
  // The current generation was retired and no replacement is running.
  | { outcome: 'unavailable'; error: Error }

export class ReloadableRuntime implements NeemRuntime {
  readonly finished: Promise<void>
  private readonly finish
  private current: NeemRuntime
  private context: WorkerContext
  private retiring: NeemRuntime | undefined
  private replacing: Promise<void> | undefined
  private stopping: Promise<void> | undefined
  private stopped = false
  private upstreams: readonly NeemRuntimeUpstream[] = []
  private readonly stops = new WeakMap<NeemRuntime, Promise<void>>()

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
    if (this.stopped) throw new Error('Neem runtime stopped')
    const upstreams = await this.current.start()
    this.upstreams = parseRuntimeStartResult(upstreams)
    this.watch(this.current)
    return this.upstreams
  }

  /** Why a reload would be refused right now, before anything is touched. */
  refusal(): Error | undefined {
    if (this.stopped) return new Error('Neem runtime stopped')
    if (this.replacing) return new Error('Neem runtime is already reloading')
    return undefined
  }

  async apply(next: Worker): Promise<GenerationReload> {
    const refusal = this.refusal()
    if (refusal) return { outcome: 'rejected', error: refusal }
    this.replacing = this.replace(next)
    try {
      await this.replacing
      return { outcome: 'applied' }
    } catch (error) {
      // replace() begins by retiring the current generation, so whatever
      // failed after that left no generation serving.
      return { outcome: 'unavailable', error: normalizeError(error) }
    } finally {
      this.replacing = undefined
    }
  }

  private async replace(next: Worker): Promise<void> {
    // The old generation's expected completion must not finish the Neem worker.
    this.retiring = this.current
    await this.stopGeneration(this.current)
    if (this.stopped) throw new Error('Neem runtime stopped')

    const context = { ...this.context, definition: next.definition }
    const replacement = await next.createRuntime(context)
    // Publish before start so a concurrent stop can interrupt pending readiness.
    this.current = replacement
    this.context = context
    try {
      if (this.stopped) throw new Error('Neem runtime stopped')
      const upstreams = await replacement.start()
      if (this.stopped) throw new Error('Neem runtime stopped')
      if (
        !isDeepStrictEqual(parseRuntimeStartResult(upstreams), this.upstreams)
      ) {
        throw new Error(
          'Worker update changed runtime upstreams; a runtime restart is required',
        )
      }
    } catch (error) {
      try {
        await this.stopGeneration(replacement)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Failed to reload runtime and clean up the replacement generation',
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
      await this.stopGeneration(this.current)
      // A factory already in flight still owns any resources it acquires.
      await this.replacing?.catch(() => {})
      this.finish.resolve()
    } catch (error) {
      this.finish.reject(error)
      throw error
    }
  }

  private stopGeneration(runtime: NeemRuntime): Promise<void> {
    // Replacement cleanup and a host stop can own the same generation at once.
    let stopping = this.stops.get(runtime)
    if (!stopping) {
      stopping = Promise.resolve().then(() => runtime.stop())
      this.stops.set(runtime, stopping)
    }
    return stopping
  }

  private watch(runtime: NeemRuntime): void {
    if (!runtime.finished) return
    void Promise.resolve(runtime.finished).then(
      () => {
        if (this.isCurrentUnexpectedCompletion(runtime)) {
          this.finish.reject(
            new Error('Neem runtime finished before stop was requested'),
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
