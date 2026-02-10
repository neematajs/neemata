import type { Future } from '@nmtjs/common'
import { createFuture } from '@nmtjs/common'

export class RpcManager {
  // connectionId:callId -> AbortController
  readonly rpcs = new Map<string, AbortController>()
  // connectionId:callId -> Future<void>
  readonly streams = new Map<string, Future<void>>()

  set(connectionId: string, callId: number, controller: AbortController) {
    const key = this.getKey(connectionId, callId)
    this.rpcs.set(key, controller)
  }

  get(connectionId: string, callId: number) {
    const key = this.getKey(connectionId, callId)
    return this.rpcs.get(key)
  }

  delete(connectionId: string, callId: number) {
    const key = this.getKey(connectionId, callId)
    this.rpcs.delete(key)
  }

  abort(connectionId: string, callId: number) {
    const key = this.getKey(connectionId, callId)
    const controller = this.rpcs.get(key)
    if (controller) {
      controller.abort()
      this.rpcs.delete(key)
      this.releasePull(connectionId, callId)
    }
  }

  awaitPull(
    connectionId: string,
    callId: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const key = this.getKey(connectionId, callId)
    const rpc = this.rpcs.get(key)
    if (!rpc) throw new Error(`RPC not found`)
    const future = this.streams.get(key)
    if (future) {
      return future.promise
    } else {
      const newFuture = createFuture<void>()
      if (signal)
        signal.addEventListener('abort', () => newFuture.resolve(), {
          once: true,
        })
      this.streams.set(key, newFuture)
      return newFuture.promise
    }
  }

  releasePull(connectionId: string, callId: number) {
    const key = this.getKey(connectionId, callId)
    const future = this.streams.get(key)
    if (future) {
      future.resolve()
      this.streams.delete(key)
    }
  }

  close(connectionId: string) {
    // Iterate all RPCs and abort those belonging to this connection
    // Optimization: Maintain a Set<callId> per connectionId
    for (const [key, controller] of this.rpcs) {
      if (key.startsWith(`${connectionId}:`)) {
        controller.abort()
        this.rpcs.delete(key)
      }
    }
    // Also release any pending pulls for this connection
    for (const key of this.streams.keys()) {
      if (key.startsWith(`${connectionId}:`)) {
        const future = this.streams.get(key)
        if (future) {
          future.resolve()
          this.streams.delete(key)
        }
      }
    }
  }

  private getKey(connectionId: string, callId: number) {
    return `${connectionId}:${callId}`
  }
}
