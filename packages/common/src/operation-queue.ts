import type { MaybePromise } from './types.ts'
import { createFuture } from './utils.ts'

export type OperationQueueStrategy = 'serial' | 'latest'

export type OperationQueueOptions = { strategy?: OperationQueueStrategy }

type QueuedOperation = {
  task: () => MaybePromise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

export class OperationSupersededError extends Error {
  constructor(message = 'Operation superseded') {
    super(message)
    this.name = 'OperationSupersededError'
  }
}

export class OperationQueue {
  private readonly strategy: OperationQueueStrategy
  private tail: Promise<unknown> = Promise.resolve()
  private count = 0
  private runningLatest = false
  private latestOperation: QueuedOperation | undefined
  private readonly idleWaiters = new Set<() => void>()

  constructor({ strategy = 'serial' }: OperationQueueOptions = {}) {
    this.strategy = strategy
  }

  get pending(): number {
    return this.count
  }

  get busy(): boolean {
    return this.count > 0
  }

  run<T>(task: () => MaybePromise<T>): Promise<T> {
    return this.strategy === 'latest'
      ? this.runLatest(task)
      : this.runSerial(task)
  }

  async waitIdle(): Promise<void> {
    if (!this.busy) return

    await new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve)
    })
  }

  private runSerial<T>(task: () => MaybePromise<T>): Promise<T> {
    this.count++

    const result = this.tail.then(task, task)
    this.tail = result
      .catch(() => undefined)
      .finally(() => {
        this.finishOperation()
      })

    return result
  }

  private runLatest<T>(task: () => MaybePromise<T>): Promise<T> {
    this.count++

    const { operation, promise } = createQueuedOperation(task)

    if (this.runningLatest) {
      const previous = this.latestOperation
      if (previous) {
        previous.reject(new OperationSupersededError())
        this.finishOperation()
      }
      this.latestOperation = operation
      return promise
    }

    this.runningLatest = true
    void this.runLatestOperations(operation)

    return promise
  }

  private async runLatestOperations(operation: QueuedOperation): Promise<void> {
    let current: QueuedOperation | undefined = operation

    while (current) {
      await this.runLatestOperation(current)
      current = this.latestOperation
      this.latestOperation = undefined
    }

    this.runningLatest = false
  }

  private async runLatestOperation(operation: QueuedOperation): Promise<void> {
    try {
      operation.resolve(await operation.task())
    } catch (error) {
      operation.reject(error)
    } finally {
      this.finishOperation()
    }
  }

  private finishOperation(): void {
    this.count--
    if (this.count > 0) return

    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }
}

function createQueuedOperation<T>(task: () => MaybePromise<T>): {
  operation: QueuedOperation
  promise: Promise<T>
} {
  const future = createFuture<T>()

  return {
    operation: {
      task: task as () => MaybePromise<unknown>,
      resolve: future.resolve as (value: unknown) => void,
      reject: future.reject,
    },
    promise: future.promise,
  }
}
