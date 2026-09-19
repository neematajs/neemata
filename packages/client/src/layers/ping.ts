import type { Future } from '@nmtjs/common'
import { createFuture, noopFn, withTimeout } from '@nmtjs/common'
import {
  ClientMessageType,
  ConnectionType,
  ServerMessageType,
} from '@nmtjs/protocol'

import type { ClientCore } from '../core.ts'
import { createIdCounter } from '../utils.ts'

export interface PingLayerApi {
  ping(timeout: number, signal?: AbortSignal): Promise<void>
}

export const createPingLayer = (core: ClientCore): PingLayerApi => {
  const pending = new Map<number, Future<void>>()
  const nextNonce = createIdCounter()

  const stopAll = (reason?: unknown) => {
    if (!pending.size) return

    const error = new Error('Heartbeat stopped', { cause: reason })
    for (const ping of pending.values()) {
      ping.reject(error)
    }
    pending.clear()
  }

  core.on('message', (message) => {
    switch (message.type) {
      case ServerMessageType.Pong: {
        const ping = pending.get(message.nonce)
        if (!ping) break

        pending.delete(message.nonce)
        ping.resolve()
        core.emit('pong', message.nonce)
        break
      }
      case ServerMessageType.Ping:
        core
          .sendMessage(ClientMessageType.Pong, { nonce: message.nonce })
          ?.catch(noopFn)
        break
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

      const nonce = nextNonce()
      const future = createFuture<void>()
      pending.set(nonce, future)

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
          pending.delete(nonce)
        })
    },
  }
}
