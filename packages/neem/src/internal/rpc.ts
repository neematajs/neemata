import type { TransferListItem } from 'node:worker_threads'

import { createFuture } from '@nmtjs/common'

import type { SerializedError } from './utils.ts'
import { deserializeError } from './utils.ts'

export type RpcCommand = { type: string } & Record<string, unknown>

export type RpcResponse<TResult> =
  | { id: number; type: 'result'; data?: TResult }
  | { id: number; type: 'error'; error: SerializedError }

export type RpcChannelOptions = {
  post: (
    message: Record<string, unknown>,
    transfer: readonly TransferListItem[],
  ) => void
  timeoutMs: () => number
  timeoutMessage: (type: string, timeoutMs: number) => string
}

// One request/response channel over a worker message port. Owners must call
// settleAll() on every worker exit or failure so callers never wait out a
// request timeout for a reply that can no longer arrive.
export class RpcChannel<TResult> {
  private nextId = 1
  private readonly pending = new Map<
    number,
    {
      future: ReturnType<typeof createFuture<TResult | undefined>>
      timeout: NodeJS.Timeout
    }
  >()

  constructor(private readonly options: RpcChannelOptions) {}

  request(
    command: RpcCommand,
    options: {
      timeoutMs?: number
      transfer?: readonly TransferListItem[]
    } = {},
  ): Promise<TResult | undefined> {
    const id = this.nextId++
    const message = { ...command, id }
    const future = createFuture<TResult | undefined>()
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs()
    const timeout = setTimeout(() => {
      this.pending.delete(id)
      future.reject(
        new Error(this.options.timeoutMessage(command.type, timeoutMs)),
      )
    }, timeoutMs)
    timeout.unref()

    this.pending.set(id, { future, timeout })
    this.options.post(message, options.transfer ?? [])
    return future.promise
  }

  // Settles the matching pending request; returns false for non-response
  // messages so owners can route them elsewhere.
  settle(message: { id?: unknown; type?: unknown }): boolean {
    if (typeof message.id !== 'number') return false
    const pending = this.pending.get(message.id)
    if (!pending) return false
    const response = message as RpcResponse<TResult>
    this.pending.delete(response.id)
    clearTimeout(pending.timeout)

    if (response.type === 'error') {
      pending.future.reject(deserializeError(response.error))
    } else {
      pending.future.resolve(response.data)
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
