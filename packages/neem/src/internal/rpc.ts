import type { MessagePort, TransferListItem } from 'node:worker_threads'

import type { Future, MaybePromise } from '@nmtjs/common'
import { createFuture } from '@nmtjs/common'

import type { SerializedError } from './utils.ts'
import { deserializeError, normalizeError, serializeError } from './utils.ts'

/**
 * A protocol's commands: what each request carries and what its reply
 * resolves to. Declared once per protocol; both ends derive from it.
 */
export type RpcCommandMap = Record<string, { params: object; result: unknown }>

export type NoParams = Record<string, never>

export type RpcRequest<TMap extends RpcCommandMap> = {
  [K in keyof TMap & string]: {
    id: number
    type: K
    params: TMap[K]['params']
  }
}[keyof TMap & string]

export type RpcResponse =
  | { id: number; type: 'result'; data?: unknown }
  | { id: number; type: 'error'; error: SerializedError }

// One-way messages from the serving side, e.g. readiness or failures.
export type RpcEvent<TEvent> = { type: 'event'; event: TEvent }

// Everything a served port posts back to its owner.
export type RpcMessage<TEvent> = RpcResponse | RpcEvent<TEvent>

export type RpcChannelOptions = {
  post: (
    message: RpcRequest<RpcCommandMap>,
    transfer: readonly TransferListItem[],
  ) => void
  timeoutMs: () => number
  timeoutMessage: (type: string, timeoutMs: number) => string
}

export type RpcRequestOptions = {
  timeoutMs?: number
  transfer?: readonly TransferListItem[]
}

// One request/response channel over a worker message port. Owners must call
// settleAll() on every worker exit or failure so callers never wait out a
// request timeout for a reply that can no longer arrive.
export class RpcChannel<TMap extends RpcCommandMap> {
  private nextId = 1
  private readonly pending = new Map<
    number,
    { future: Future<unknown>; timeout: NodeJS.Timeout }
  >()

  // No parameter property: worker entries load this module with Node's
  // type stripping, which rejects them.
  private readonly options: RpcChannelOptions

  constructor(options: RpcChannelOptions) {
    this.options = options
  }

  request<K extends keyof TMap & string>(
    type: K,
    params: TMap[K]['params'],
    options: RpcRequestOptions = {},
  ): Promise<TMap[K]['result']> {
    const id = this.nextId++
    const future = createFuture<unknown>()
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs()
    const timeout = setTimeout(() => {
      this.pending.delete(id)
      future.reject(new Error(this.options.timeoutMessage(type, timeoutMs)))
    }, timeoutMs)
    timeout.unref()

    this.pending.set(id, { future, timeout })
    try {
      this.options.post({ id, type, params }, options.transfer ?? [])
    } catch (error) {
      // Nothing was sent, so no reply can settle this request.
      this.pending.delete(id)
      clearTimeout(timeout)
      future.reject(normalizeError(error))
    }
    return future.promise as Promise<TMap[K]['result']>
  }

  // Settles the matching pending request; returns false for anything that is
  // not a reply to one, so owners can route events elsewhere.
  settle(message: unknown): boolean {
    if (!isRpcResponse(message)) return false
    const pending = this.pending.get(message.id)
    if (!pending) return false
    this.pending.delete(message.id)
    clearTimeout(pending.timeout)

    if (message.type === 'error') {
      pending.future.reject(deserializeError(message.error))
    } else {
      pending.future.resolve(message.data)
    }
    return true
  }

  settleAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.future.reject(error)
    }
    this.pending.clear()
  }
}

export function isRpcEvent<TEvent>(
  message: unknown,
): message is RpcEvent<TEvent> {
  return isRecord(message) && message.type === 'event' && 'event' in message
}

function isRpcResponse(message: unknown): message is RpcResponse {
  if (!isRecord(message) || typeof message.id !== 'number') return false
  if (message.type === 'result') return true
  return message.type === 'error' && isRecord(message.error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// What a server's beforeExit hook gets when its exit carries no budget, e.g. a
// crash: enough for a best-effort flush without holding up the failure.
export const DEFAULT_EXIT_HOOK_TIMEOUT_MS = 1_000

export type RpcHandlerContext = {
  /**
   * Exits the process with `code` once this request's reply is posted, giving
   * the server's `beforeExit` hook up to `timeoutMs`.
   */
  exitAfterReply: (code: number, timeoutMs?: number) => void
}

export type RpcHandlers<TMap extends RpcCommandMap> = {
  [K in keyof TMap]: (
    params: TMap[K]['params'],
    context: RpcHandlerContext,
  ) => MaybePromise<TMap[K]['result']>
}

export type RpcServerOptions<TMap extends RpcCommandMap> = {
  /**
   * Commands that must not overlap an earlier request of the same type; each
   * is queued behind the previous one. Every other command runs on arrival.
   */
  serial?: readonly (keyof TMap & string)[]
  // Runs once on exit before the parent port closes, e.g. to close ports the
  // entry owns.
  onClose?: () => void
  /**
   * Awaited once on exit, after the ports close and before `process.exit`, so
   * the entry can flush what an exit would drop. It must settle within the
   * `timeoutMs` it is given; a rejection is ignored.
   */
  beforeExit?: (timeoutMs: number) => MaybePromise<void>
}

export type RpcServer<TEvent> = {
  post: (event: TEvent) => void
  /**
   * Posts `event` as the last message, closes the ports, runs `beforeExit`
   * within DEFAULT_EXIT_HOOK_TIMEOUT_MS and yields once so the parent receives
   * the event before the exit event. The first exit wins.
   */
  exit: (code: number, event?: TEvent) => Promise<void>
}

/**
 * Serves a protocol on a worker's parent port. Every request gets exactly one
 * reply: its result, or its error, including for a command this entry does
 * not know, so a caller never waits out its timeout for a missing handler.
 */
export function serveRpc<TMap extends RpcCommandMap, TEvent>(
  port: MessagePort | null,
  name: string,
  handlers: RpcHandlers<TMap>,
  options: RpcServerOptions<TMap> = {},
): RpcServer<TEvent> {
  if (!port) throw new Error(`${name} requires a parent port`)
  const serial = new Set<string>(options.serial)
  const queues = new Map<string, Promise<void>>()
  let exiting: Promise<void> | undefined

  const post = (message: RpcMessage<TEvent>) => port.postMessage(message)

  const exitWithin = (
    code: number,
    event: TEvent | undefined,
    timeoutMs: number,
  ): Promise<void> =>
    (exiting ??= (async () => {
      if (event !== undefined) post({ type: 'event', event })
      options.onClose?.()
      port.close()
      try {
        await options.beforeExit?.(timeoutMs)
      } catch {
        // The exit goes ahead regardless; there is nobody left to report to.
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
      process.exit(code)
    })())

  const exit = (code: number, event?: TEvent): Promise<void> =>
    exitWithin(code, event, DEFAULT_EXIT_HOOK_TIMEOUT_MS)

  const run = async (id: number, type: string, params: unknown) => {
    let exitAfter: { code: number; timeoutMs: number } | undefined
    const context: RpcHandlerContext = {
      exitAfterReply: (code, timeoutMs = DEFAULT_EXIT_HOOK_TIMEOUT_MS) => {
        exitAfter = { code, timeoutMs }
      },
    }
    try {
      if (!Object.hasOwn(handlers, type)) {
        throw new Error(`${name} received unknown command [${type}]`)
      }
      const handler = handlers[type] as (
        params: unknown,
        context: RpcHandlerContext,
      ) => unknown
      const data = await handler(params, context)
      post({ id, type: 'result', data })
    } catch (error) {
      post({ id, type: 'error', error: serializeError(error) })
    }
    if (exitAfter) {
      await exitWithin(exitAfter.code, undefined, exitAfter.timeoutMs)
    }
  }

  port.on('message', (message: unknown) => {
    if (!isRecord(message) || typeof message.id !== 'number') return
    const { id, params } = message
    const type = String(message.type)
    if (!serial.has(type)) {
      void run(id, type, params)
      return
    }
    const next = (queues.get(type) ?? Promise.resolve()).then(() =>
      run(id, type, params),
    )
    queues.set(type, next)
  })

  return { post: (event) => post({ type: 'event', event }), exit }
}
