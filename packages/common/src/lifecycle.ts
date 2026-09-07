import type { MaybePromise } from './types.ts'

export type Teardown = () => MaybePromise<unknown>

/**
 * LIFO stack of teardown callbacks. Acquisitions register their undo at the
 * moment they succeed, so "roll back a partial start" and "stop a running
 * component" become the same operation: unwind. This keeps release ordering
 * a structural property instead of something every lifecycle owner
 * re-implements (and lets drift) on its least-tested path.
 *
 * Ordering note: defer() position, not acquisition time, decides unwind
 * order. A resource whose release must happen *after* later acquisitions are
 * released (e.g. closing a socket only after its tenants are disposed) is
 * deferred *before* those acquisitions are made.
 */
export class TeardownStack {
  #teardowns: Teardown[] = []

  get size(): number {
    return this.#teardowns.length
  }

  defer(teardown: Teardown): void {
    this.#teardowns.push(teardown)
  }

  /**
   * Run all teardowns in reverse registration order and clear the stack.
   * Every teardown runs even if earlier ones throw; errors are collected and
   * returned rather than thrown so callers decide how to surface them.
   */
  async unwind(): Promise<unknown[]> {
    const teardowns = this.#teardowns
    this.#teardowns = []
    const errors: unknown[] = []
    for (let i = teardowns.length - 1; i >= 0; i--) {
      try {
        await teardowns[i]()
      } catch (error) {
        errors.push(error)
      }
    }
    return errors
  }
}

export type LifecycleState = 'idle' | 'starting' | 'running' | 'stopping'

/**
 * Serialized start/stop lifecycle around a TeardownStack.
 *
 * Guarantees, in one place instead of per-caller convention:
 * - start/stop transitions are serialized; a stop() issued during an
 *   in-flight start() waits for it and then actually stops.
 * - start() on a running component rejects; stop() on an idle one no-ops.
 * - a failed start() unwinds exactly what it acquired and leaves the
 *   component restartable; the original error is rethrown first-class (an
 *   AggregateError wraps it only when the rollback itself also failed).
 * - a failed operation never poisons the queue: later calls still run.
 */
export class Lifecycle<StartResult = unknown> {
  #state: LifecycleState = 'idle'
  #queue: Promise<unknown> = Promise.resolve()
  #stack = new TeardownStack()

  constructor(protected readonly name: string) {}

  get state(): LifecycleState {
    return this.#state
  }

  start(
    run: (defer: (teardown: Teardown) => void) => Promise<StartResult>,
  ): Promise<StartResult> {
    return this.#enqueue(async () => {
      if (this.#state !== 'idle') {
        throw new Error(`The ${this.name} is already started`)
      }
      this.#state = 'starting'
      try {
        const result = await run((teardown) => this.#stack.defer(teardown))
        this.#state = 'running'
        return result
      } catch (error) {
        const rollbackErrors = await this.#stack.unwind()
        this.#state = 'idle'
        if (rollbackErrors.length) {
          throw new AggregateError(
            [error, ...rollbackErrors],
            `Failed to start the ${this.name} and roll back resources`,
          )
        }
        throw error
      }
    })
  }

  stop(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#state !== 'running') return
      this.#state = 'stopping'
      const errors = await this.#stack.unwind()
      this.#state = 'idle'
      if (errors.length) {
        throw new AggregateError(errors, `Failed to stop the ${this.name}`)
      }
    })
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation)
    // chain continues on a settled copy so a rejected operation reaches only
    // its own caller and never blocks or re-rejects later transitions
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
