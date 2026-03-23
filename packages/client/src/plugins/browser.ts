import type { ClientPlugin } from './types.ts'

const syncPauseReasons = (
  setPauseReason: (reason: string, active: boolean) => void,
) => {
  if (globalThis.window && 'navigator' in globalThis.window) {
    setPauseReason('offline', globalThis.window.navigator?.onLine === false)
  }

  if (globalThis.document) {
    setPauseReason(
      'tab_hidden',
      globalThis.document.visibilityState === 'hidden',
    )
  }
}

export const browserConnectivityPlugin = (): ClientPlugin => {
  return ({ core }) => {
    const cleanup: Array<() => void> = []

    const triggerReconnect = () => {
      if (!core.isDisposed()) {
        core.triggerReconnect()
      }
    }

    return {
      name: 'browser-connectivity',
      onInit: () => {
        syncPauseReasons(core.setReconnectPauseReason.bind(core))

        if (globalThis.window) {
          const onPageShow = () => triggerReconnect()
          globalThis.window.addEventListener('pageshow', onPageShow)
          cleanup.push(() =>
            globalThis.window?.removeEventListener('pageshow', onPageShow),
          )

          const onOnline = () => {
            core.setReconnectPauseReason('offline', false)
            triggerReconnect()
          }
          globalThis.window.addEventListener('online', onOnline)
          cleanup.push(() =>
            globalThis.window?.removeEventListener('online', onOnline),
          )

          const onOffline = () => {
            core.setReconnectPauseReason('offline', true)
          }
          globalThis.window.addEventListener('offline', onOffline)
          cleanup.push(() =>
            globalThis.window?.removeEventListener('offline', onOffline),
          )

          const onFocus = () => triggerReconnect()
          globalThis.window.addEventListener('focus', onFocus)
          cleanup.push(() =>
            globalThis.window?.removeEventListener('focus', onFocus),
          )
        }

        if (globalThis.document) {
          const onVisibilityChange = () => {
            const hidden = globalThis.document?.visibilityState === 'hidden'
            core.setReconnectPauseReason('tab_hidden', hidden)
            if (!hidden) {
              triggerReconnect()
            }
          }

          globalThis.document.addEventListener(
            'visibilitychange',
            onVisibilityChange,
          )
          cleanup.push(() =>
            globalThis.document?.removeEventListener(
              'visibilitychange',
              onVisibilityChange,
            ),
          )
        }
      },
      dispose: () => {
        for (const stop of cleanup) stop()
        cleanup.length = 0
      },
    }
  }
}
