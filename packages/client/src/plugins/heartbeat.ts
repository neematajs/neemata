import { ConnectionType } from '@nmtjs/protocol'

import type { ClientPlugin } from './types.ts'

const DEFAULT_HEARTBEAT_INTERVAL = 15000
const DEFAULT_HEARTBEAT_TIMEOUT = 5000

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

const isPaused = () => {
  if (globalThis.window && 'navigator' in globalThis.window) {
    if (globalThis.window.navigator?.onLine === false) return true
  }
  if (globalThis.document) {
    if (globalThis.document.visibilityState === 'hidden') return true
  }
  return false
}

export interface HeartbeatPluginOptions {
  interval?: number
  timeout?: number
}

export const heartbeatPlugin = (
  options: HeartbeatPluginOptions = {},
): ClientPlugin => {
  return (client) => {
    const interval = options.interval ?? DEFAULT_HEARTBEAT_INTERVAL
    const timeout = options.timeout ?? DEFAULT_HEARTBEAT_TIMEOUT

    let heartbeatAbortController: AbortController | null = null
    let heartbeatTask: Promise<void> | null = null

    const stopHeartbeat = () => {
      heartbeatAbortController?.abort()
      heartbeatAbortController = null
      heartbeatTask = null
    }

    const startHeartbeat = () => {
      if (heartbeatTask) return
      if (client.transportType !== ConnectionType.Bidirectional) return

      heartbeatAbortController = new AbortController()
      const signal = heartbeatAbortController.signal

      heartbeatTask = (async () => {
        while (
          !signal.aborted &&
          !client.isDisposed() &&
          client.state === 'connected'
        ) {
          if (isPaused()) {
            await sleep(1000, signal)
            continue
          }

          await sleep(interval, signal)

          if (
            signal.aborted ||
            client.isDisposed() ||
            client.state !== 'connected'
          ) {
            continue
          }

          try {
            await client.ping(timeout, signal)
          } catch {
            if (
              !signal.aborted &&
              !client.isDisposed() &&
              client.state === 'connected'
            ) {
              await client
                .requestReconnect('heartbeat_timeout')
                .catch(() => void 0)
            }
          }
        }
      })().finally(() => {
        heartbeatTask = null
        heartbeatAbortController = null
      })
    }

    return {
      name: 'heartbeat',
      onConnect: startHeartbeat,
      onDisconnect: () => stopHeartbeat(),
      dispose: stopHeartbeat,
    }
  }
}
