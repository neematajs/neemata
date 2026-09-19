import type { ClientPlugin } from './types.ts'
import { isOffline, isTabHidden } from '../utils.ts'

export const browserConnectivityPlugin = (): ClientPlugin => {
  return ({ core }) => {
    const listeners = new AbortController()
    const { signal } = listeners

    const triggerReconnect = () => {
      if (!core.isDisposed()) {
        core.triggerReconnect()
      }
    }

    return {
      name: 'browser-connectivity',
      onInit: () => {
        core.setReconnectPauseReason('offline', isOffline())
        core.setReconnectPauseReason('tab_hidden', isTabHidden())

        globalThis.window?.addEventListener('pageshow', triggerReconnect, {
          signal,
        })
        globalThis.window?.addEventListener('focus', triggerReconnect, {
          signal,
        })
        globalThis.window?.addEventListener(
          'online',
          () => {
            core.setReconnectPauseReason('offline', false)
            triggerReconnect()
          },
          { signal },
        )
        globalThis.window?.addEventListener(
          'offline',
          () => {
            core.setReconnectPauseReason('offline', true)
          },
          { signal },
        )

        globalThis.document?.addEventListener(
          'visibilitychange',
          () => {
            const hidden = isTabHidden()
            core.setReconnectPauseReason('tab_hidden', hidden)
            if (!hidden) {
              triggerReconnect()
            }
          },
          { signal },
        )
      },
      dispose: () => listeners.abort(),
    }
  }
}
