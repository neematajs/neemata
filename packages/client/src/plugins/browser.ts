import type { ClientPlugin } from './types.ts'

export const browserConnectivityPlugin = (): ClientPlugin => {
  return (client) => {
    const cleanup: Array<() => void> = []

    const maybeConnect = () => {
      if (client.state === 'disconnected' && !client.isDisposed()) {
        client.connect().catch(() => void 0)
      }
    }

    return {
      name: 'browser-connectivity',
      onInit: () => {
        if (globalThis.window) {
          const onPageShow = () => maybeConnect()
          globalThis.window.addEventListener('pageshow', onPageShow)
          cleanup.push(() =>
            globalThis.window?.removeEventListener('pageshow', onPageShow),
          )

          const onOnline = () => maybeConnect()
          globalThis.window.addEventListener('online', onOnline)
          cleanup.push(() =>
            globalThis.window?.removeEventListener('online', onOnline),
          )

          const onFocus = () => maybeConnect()
          globalThis.window.addEventListener('focus', onFocus)
          cleanup.push(() =>
            globalThis.window?.removeEventListener('focus', onFocus),
          )
        }

        if (globalThis.document) {
          const onVisibilityChange = () => {
            if (globalThis.document?.visibilityState === 'visible') {
              maybeConnect()
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
