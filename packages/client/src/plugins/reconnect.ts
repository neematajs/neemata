import { ConnectionType } from '@nmtjs/protocol'

import type { ClientDisconnectReason, ClientPlugin } from './types.ts'

const DEFAULT_RECONNECT_TIMEOUT = 1000
const DEFAULT_MAX_RECONNECT_TIMEOUT = 60000

const sleep = (ms: number, signal?: AbortSignal) => {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    }
  })
}

const computeReconnectDelay = (ms: number) => {
  if (globalThis.window) {
    const jitter = Math.floor(ms * 0.2 * Math.random())
    return ms + jitter
  }
  return ms
}

const isReconnectPaused = () => {
  if (globalThis.window && 'navigator' in globalThis.window) {
    if (globalThis.window.navigator?.onLine === false) return true
  }
  if (globalThis.document) {
    if (globalThis.document.visibilityState === 'hidden') return true
  }
  return false
}

export interface ReconnectPluginOptions {
  initialTimeout?: number
  maxTimeout?: number
}

export const reconnectPlugin = (
  options: ReconnectPluginOptions = {},
): ClientPlugin => {
  return (client) => {
    let reconnecting: Promise<void> | null = null
    let reconnectAbortController: AbortController | null = null
    let reconnectTimeout = options.initialTimeout ?? DEFAULT_RECONNECT_TIMEOUT

    const cancelReconnect = () => {
      reconnectAbortController?.abort()
      reconnectAbortController = null
      reconnecting = null
    }

    const ensureReconnectLoop = () => {
      if (reconnecting) return

      reconnectAbortController = new AbortController()
      const signal = reconnectAbortController.signal

      reconnecting = (async () => {
        while (
          !signal.aborted &&
          !client.isDisposed() &&
          client.state === 'disconnected' &&
          client.lastDisconnectReason !== 'client'
        ) {
          if (isReconnectPaused()) {
            await sleep(1000, signal)
            continue
          }

          const delay = computeReconnectDelay(reconnectTimeout)
          await sleep(delay, signal)

          if (
            signal.aborted ||
            client.isDisposed() ||
            client.state !== 'disconnected' ||
            client.lastDisconnectReason === 'client'
          ) {
            break
          }

          const previousTimeout = reconnectTimeout
          await client.connect().catch(() => void 0)

          if (client.state === 'disconnected') {
            reconnectTimeout = Math.min(
              previousTimeout * 2,
              options.maxTimeout ?? DEFAULT_MAX_RECONNECT_TIMEOUT,
            )
          }
        }
      })().finally(() => {
        reconnecting = null
        reconnectAbortController = null
      })
    }

    const onDisconnect = (reason: ClientDisconnectReason) => {
      if (
        client.transportType !== ConnectionType.Bidirectional ||
        reason === 'client' ||
        client.isDisposed()
      ) {
        cancelReconnect()
        return
      }
      ensureReconnectLoop()
    }

    return {
      name: 'reconnect',
      onConnect: () => {
        reconnectTimeout = options.initialTimeout ?? DEFAULT_RECONNECT_TIMEOUT
        cancelReconnect()
      },
      onDisconnect,
      dispose: cancelReconnect,
    }
  }
}
