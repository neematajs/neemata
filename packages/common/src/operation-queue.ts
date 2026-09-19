import type { MaybePromise } from './types.ts'
import { createFuture } from './utils.ts'

export type OperationQueueStrategy = 'serial' | 'latest'

export type OperationQueueOptions = { strategy?: OperationQueueStrategy }

// Erases the caller's result type: the queue only needs to start it and to
// settle it when it is dropped.
type QueuedOperation = {
  run: () => Promise<void>
  supersede: () => void
}

export class OperationSupersededError extends Error {
  override name = 'OperationSupersededError'

  constructor(message = 'Operation superseded') {
    super(message)
  }
}

export class OperationQueue {
  readonly #strategy: OperationQueueStrategy
  readonly #idleWaiters = new Set<() => void>()
  #tail: Promise<unknown> = Promise.resolve()
  #count = 0
  #running = false
  #latest: QueuedOperation | undefined

  constructor({ strategy = 'serial' }: OperationQueueOptions = {}) {
    this.#strategy = strategy
  }

  get pending(): number {
    return this.#count
  }

  get busy(): boolean {
    return this.#count > 0
  }

  run<T>(task: () => MaybePromise<T>): Promise<T> {
    return this.#strategy === 'latest'
      ? this.#runLatest(task)
      : this.#runSerial(task)
  }

  async waitIdle(): Promise<void> {
    if (!this.busy) return

    await new Promise<void>((resolve) => {
      this.#idleWaiters.add(resolve)
    })
  }

  #runSerial<T>(task: () => MaybePromise<T>): Promise<T> {
    this.#count++

    const result = this.#tail.then(task, task)
    this.#tail = result
      .catch(() => undefined)
      .finally(() => {
        this.#finish()
      })

    return result
  }

  #runLatest<T>(task: () => MaybePromise<T>): Promise<T> {
    this.#count++

    const { promise, resolve, reject } = createFuture<T>()
    const operation: QueuedOperation = {
      run: async () => {
        try {
          resolve(await task())
        } catch (error) {
          reject(error)
        } finally {
          this.#finish()
        }
      },
      supersede: () => {
        reject(new OperationSupersededError())
        this.#finish()
      },
    }

    if (this.#running) {
      this.#latest?.supersede()
      this.#latest = operation
      return promise
    }

    this.#running = true
    void this.#drainLatest(operation)

    return promise
  }

  async #drainLatest(operation: QueuedOperation): Promise<void> {
    let current: QueuedOperation | undefined = operation

    while (current) {
      await current.run()
      current = this.#latest
      this.#latest = undefined
    }

    this.#running = false
  }

  #finish(): void {
    this.#count--
    if (this.#count > 0) return

    for (const resolve of this.#idleWaiters) resolve()
    this.#idleWaiters.clear()
  }
}
