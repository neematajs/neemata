import type { NeemLifecycleConfig } from '../../shared/types.ts'
import { raceWithTimeout, wait } from '../utils.ts'

export const DEFAULT_STOP_TIMEOUT_MS = 15_000
export const DEFAULT_START_TIMEOUT_MS = 30_000
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
// Held back from the exit budget a stopping thread is given, so its exit still
// reaches the host, which terminates it at the deadline, after the thread has
// spent that budget flushing.
const EXIT_BUDGET_MARGIN_MS = 250

// The budget a thread is told it has left to exit in, out of what the host
// still waits for it.
export function exitBudget(remainingMs: number): number {
  return Math.max(0, remainingMs - EXIT_BUDGET_MARGIN_MS)
}

export function resolveLifecycle(
  config: NeemLifecycleConfig | undefined,
): Required<NeemLifecycleConfig> {
  return {
    stopTimeout: config?.stopTimeout ?? DEFAULT_STOP_TIMEOUT_MS,
    startTimeout: config?.startTimeout ?? DEFAULT_START_TIMEOUT_MS,
  }
}

// Cancellation is an outcome of its own: callers must tell it apart from a
// failure, so it is never reported, retried or cleaned up as one.
export class OperationAbortedError extends Error {
  constructor(message = 'Neem operation aborted') {
    super(message)
    this.name = 'AbortError'
  }
}

export function isOperationAborted(
  error: unknown,
): error is OperationAbortedError {
  return error instanceof OperationAbortedError
}

/**
 * One start, reload, recovery or stop. Aborting a scope aborts its children;
 * the deadline only ever shrinks down the tree, so nested stops share the
 * budget of the stop that created them.
 */
export class OperationScope {
  readonly signal: AbortSignal
  readonly deadline: number | undefined
  private readonly controller = new AbortController()
  private readonly detach: (() => void) | undefined

  constructor(options: { parent?: OperationScope; deadline?: number } = {}) {
    const { parent } = options
    this.signal = this.controller.signal
    this.deadline = earliest(options.deadline, parent?.deadline)
    if (!parent) return
    if (parent.signal.aborted) {
      this.controller.abort()
      return
    }
    const onAbort = () => this.abort()
    parent.signal.addEventListener('abort', onAbort, { once: true })
    this.detach = () => parent.signal.removeEventListener('abort', onAbort)
  }

  static withTimeout(timeoutMs: number): OperationScope {
    return new OperationScope({ deadline: Date.now() + timeoutMs })
  }

  get aborted(): boolean {
    return this.signal.aborted
  }

  remaining(): number {
    if (this.deadline === undefined) return Number.POSITIVE_INFINITY
    return Math.max(0, this.deadline - Date.now())
  }

  throwIfAborted(): void {
    if (this.signal.aborted) throw new OperationAbortedError()
  }

  abort(): void {
    this.controller.abort()
  }

  child(): OperationScope {
    return new OperationScope({ parent: this })
  }

  /**
   * Awaits something this operation does not own (a hook, a reply, another
   * thread's readiness): abort settles the wait at once and the owner of the
   * underlying resource cleans it up.
   */
  async wait<T>(value: PromiseLike<T> | T): Promise<T> {
    if (this.signal.aborted) {
      // Callers launch `value` before this check. Nobody else awaits it, so
      // its eventual rejection would otherwise go unhandled.
      void Promise.resolve(value).catch(noop)
      throw new OperationAbortedError()
    }
    const result = await new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new OperationAbortedError())
      this.signal.addEventListener('abort', onAbort, { once: true })
      Promise.resolve(value).then(
        (settled) => {
          this.signal.removeEventListener('abort', onAbort)
          resolve(settled)
        },
        (error: unknown) => {
          this.signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
    this.throwIfAborted()
    return result
  }

  /**
   * Bounds a stop step that does not take the scope itself (a hook, closing a
   * server) by the deadline. A step that misses it is left running and fails
   * here, so the caller records the error and still runs the next step.
   */
  async within<T>(value: PromiseLike<T>, label: string): Promise<T> {
    const result = await raceWithTimeout(
      Promise.resolve(value),
      this.remaining(),
    )
    if (result.timedOut) {
      throw new Error(`${label} did not finish within the stop budget`)
    }
    return result.value
  }

  async sleep(ms: number): Promise<void> {
    this.throwIfAborted()
    try {
      await wait(ms, { signal: this.signal })
    } catch (error) {
      if (this.signal.aborted) throw new OperationAbortedError()
      throw error
    }
  }

  // Children of a long-lived scope must detach once they settle.
  dispose(): void {
    this.detach?.()
  }
}

function earliest(
  first: number | undefined,
  second: number | undefined,
): number | undefined {
  if (first === undefined) return second
  if (second === undefined) return first
  return Math.min(first, second)
}

function noop(): void {}
