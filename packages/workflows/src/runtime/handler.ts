import type { MaybePromise } from '../types/index.ts'

export class WorkflowCleanupTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Workflow cleanup exceeded ${timeoutMs}ms; worker recycling required`)
    this.name = 'WorkflowCleanupTimeoutError'
  }
}

export type HandlerRunnerOptions = {
  readonly cleanupTimeoutMs?: number
  readonly onFatal?: (error: unknown) => void
}

/**
 * Bounds how long an aborted handler may keep cleaning up, and remembers the
 * ones still running so the owner of their dependencies can wait for them.
 */
export type HandlerRunner = {
  readonly run: <A>(
    handler: () => MaybePromise<A>,
    signal?: AbortSignal,
  ) => Promise<A>
  readonly drain: () => Promise<void>
}

export function createHandlerRunner(
  options: HandlerRunnerOptions = {},
): HandlerRunner {
  const timeoutMs = options.cleanupTimeoutMs ?? 5_000
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error(
      'Workflow cleanupTimeoutMs must be a finite non-negative number',
    )
  }
  const pending = new Set<Promise<unknown>>()
  return {
    async run(handler, signal) {
      // Do not enter user code for an attempt that has already lost ownership.
      if (signal?.aborted) throw signal.reason
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      // Listening before user code runs: a handler may abort its own attempt
      // synchronously, such as by stopping the worker, and abort events are
      // not replayed.
      const overrun = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          timer = setTimeout(() => {
            const error = new WorkflowCleanupTimeoutError(timeoutMs)
            reject(error)
            options.onFatal?.(error)
          }, timeoutMs)
        }
        signal?.addEventListener('abort', onAbort, { once: true })
      })
      // Entered synchronously, so no abort can land between the check and the call.
      const work = (async () => handler())()
      pending.add(work)
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      )
      try {
        return await Promise.race([work, overrun])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        if (onAbort) signal?.removeEventListener('abort', onAbort)
      }
    },
    async drain() {
      // Overrun is reported separately; it never authorizes disposing shared
      // dependencies while a handler that ignores its signal still uses them.
      while (pending.size > 0) await Promise.allSettled(pending)
    },
  }
}
