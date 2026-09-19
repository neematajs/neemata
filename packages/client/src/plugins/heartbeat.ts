import { noopFn } from '@nmtjs/common'
import { ConnectionType } from '@nmtjs/protocol'

import type { ClientPlugin } from './types.ts'
import { isOffline, isTabHidden, sleep } from '../utils.ts'

const DEFAULT_HEARTBEAT_INTERVAL = 15000
const DEFAULT_HEARTBEAT_TIMEOUT = 5000
const PAUSE_POLL_INTERVAL = 1000

export interface HeartbeatPluginOptions {
  interval?: number
  timeout?: number
}

export const heartbeatPlugin = (
  options: HeartbeatPluginOptions = {},
): ClientPlugin => {
  return ({ core, ping }) => {
    const interval = options.interval ?? DEFAULT_HEARTBEAT_INTERVAL
    const timeout = options.timeout ?? DEFAULT_HEARTBEAT_TIMEOUT

    let controller: AbortController | null = null

    const stop = () => {
      controller?.abort()
      controller = null
    }

    const start = () => {
      if (controller) return
      if (core.transportType !== ConnectionType.Bidirectional) return

      const beating = new AbortController()
      controller = beating
      const { signal } = beating

      const isActive = () =>
        !signal.aborted && !core.isDisposed() && core.state === 'connected'

      void (async () => {
        while (isActive()) {
          if (isOffline() || isTabHidden()) {
            await sleep(PAUSE_POLL_INTERVAL, signal)
            continue
          }

          await sleep(interval, signal)

          if (!isActive()) continue

          try {
            await ping.ping(timeout, signal)
          } catch {
            if (isActive()) {
              await core.requestReconnect('heartbeat_timeout').catch(noopFn)
            }
          }
        }
      })().finally(() => {
        if (controller === beating) controller = null
      })
    }

    return {
      name: 'heartbeat',
      onConnect: start,
      onDisconnect: stop,
      dispose: stop,
    }
  }
}
