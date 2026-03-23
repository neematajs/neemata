import type { Future } from '@nmtjs/common'
import { createFuture, MAX_UINT32, withTimeout } from '@nmtjs/common'
import {
  ClientMessageType,
  ConnectionType,
  ServerMessageType,
} from '@nmtjs/protocol'

import type { ClientCore } from '../core.ts'

export interface PingLayerApi {
  ping(timeout: number, signal?: AbortSignal): Promise<void>
  stopAll(reason?: unknown): void
}

export const createPingLayer = (core: ClientCore): PingLayerApi => {
  let pingNonce = 0
  const pendingPings = new Map<number, Future<void>>()

  const nextPingNonce = () => {
    if (pingNonce >= MAX_UINT32) {
      pingNonce = 0
    }

    return pingNonce++
  }

  const stopAll = (reason?: unknown) => {
    if (!pendingPings.size) return

    const error = new Error('Heartbeat stopped', { cause: reason })
    for (const pending of pendingPings.values()) {
      pending.reject(error)
    }
    pendingPings.clear()
  }

  core.on('message', (message: any) => {
    switch (message.type) {
      case ServerMessageType.Pong: {
        const pending = pendingPings.get(message.nonce)
        if (!pending) return

        pendingPings.delete(message.nonce)
        pending.resolve()
        core.emit('pong', message.nonce)
        break
      }
      case ServerMessageType.Ping: {
        if (!core.messageContext) return

        const buffer = core.protocol.encodeMessage(
          core.messageContext,
          ClientMessageType.Pong,
          { nonce: message.nonce },
        )

        core.send(buffer).catch(() => {})
        break
      }
    }
  })

  core.on('disconnected', (reason) => {
    stopAll(reason)
  })

  return {
    ping(timeout: number, signal?: AbortSignal) {
      if (
        core.transportType !== ConnectionType.Bidirectional ||
        core.state !== 'connected' ||
        !core.messageContext
      ) {
        return Promise.reject(new Error('Client is not connected'))
      }

      const nonce = nextPingNonce()
      const future = createFuture<void>()
      pendingPings.set(nonce, future)

      const buffer = core.protocol.encodeMessage(
        core.messageContext,
        ClientMessageType.Ping,
        { nonce },
      )

      return core
        .send(buffer, signal)
        .then(() =>
          withTimeout(future.promise, timeout, new Error('Heartbeat timeout')),
        )
        .finally(() => {
          pendingPings.delete(nonce)
        })
    },
    stopAll,
  }
}
