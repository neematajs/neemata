export type NeemWorkerErrorOrigin = 'bootstrap' | 'start' | 'runtime'

/**
 * A failure reported by a runtime worker thread, as seen from the host. The
 * worker logged the original value itself before exiting; `cause` carries
 * the rendered summary that crossed the thread boundary. Lets hooks and
 * failure handlers tell a worker crash from a host-side failure.
 */
export class NeemWorkerError extends Error {
  readonly worker: string
  readonly origin: NeemWorkerErrorOrigin

  constructor(input: {
    readonly worker: string
    readonly origin: NeemWorkerErrorOrigin
    readonly cause: Error
  }) {
    super(
      `Worker [${input.worker}] ${input.origin} error: ${input.cause.message}`,
      { cause: input.cause },
    )
    this.name = 'NeemWorkerError'
    this.worker = input.worker
    this.origin = input.origin
  }
}
