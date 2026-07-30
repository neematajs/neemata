import type {
  ServerFetchHandler,
  ServerHost,
  ServerHostOptions,
  ServerNativeHandles,
  ServerRuntimeName,
  ServerWebSocketRegistration,
} from './types.ts'

export const DEFAULT_MAX_REQUEST_BODY_SIZE = 1024 * 1024 * 128 // 128MiB

/**
 * Reference-counted host base. Registration happens while the host is idle
 * (transports register at construction, before any gateway start), and the
 * runtime server is materialized lazily in bind() from the collected
 * registrations — required by runtimes like Bun where fetch/websocket
 * handlers must all be known at serve() time, and it also makes a
 * stop()-then-start() cycle rebind cleanly on every runtime.
 */
export abstract class BaseServerHost<
  R extends ServerRuntimeName,
> implements ServerHost<R> {
  abstract readonly runtime: R
  protected fetchHandler?: ServerFetchHandler
  protected webSocket?: ServerWebSocketRegistration<R>
  #refs = 0
  #bound: Promise<string> | null = null

  constructor(protected readonly options: ServerHostOptions<R>) {}

  abstract get native(): ServerNativeHandles

  setFetchHandler(handler: ServerFetchHandler): void {
    if (this.#bound) {
      throw new Error('Cannot register a fetch handler on a started server')
    }
    if (this.fetchHandler) {
      throw new Error('A fetch handler is already registered on this server')
    }
    this.fetchHandler = handler
  }

  setWebSocket(registration: ServerWebSocketRegistration<R>): void {
    if (this.#bound) {
      throw new Error('Cannot register a WebSocket handler on a started server')
    }
    if (this.webSocket) {
      throw new Error(
        'A WebSocket handler is already registered on this server',
      )
    }
    this.webSocket = registration
  }

  isSendSuccess(_status: number): boolean {
    return true
  }

  async start(): Promise<string> {
    this.#refs++
    try {
      this.#bound ??= this.bind()
      return await this.#bound
    } catch (error) {
      // roll back this claim; the last failed claimant clears the rejected
      // bind so a later start() can attempt a fresh one
      this.#refs--
      if (this.#refs === 0) this.#bound = null
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.#refs === 0) return
    this.#refs--
    // the socket closes only after every registrant has stopped
    if (this.#refs > 0) return
    const bound = this.#bound
    this.#bound = null
    if (bound) {
      // a concurrent in-flight bind must settle before closing
      await bound.catch(() => undefined)
      await this.close()
    }
  }

  protected get maxRequestBodySize(): number {
    return this.options.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY_SIZE
  }

  /**
   * Materialize the runtime server from the collected registrations, bind
   * the socket and resolve with the bound URL.
   */
  protected abstract bind(): Promise<string>
  protected abstract close(): Promise<void>
}
