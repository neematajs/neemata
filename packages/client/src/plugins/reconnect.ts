import type { ClientPlugin } from './types.ts'

export interface ReconnectPluginOptions {
  initialTimeout?: number
  maxTimeout?: number
}

export const reconnectPlugin = (
  options: ReconnectPluginOptions = {},
): ClientPlugin => {
  return ({ core }) => ({
    name: 'reconnect',
    onInit: () => {
      core.configureReconnect({
        initialTimeout: options.initialTimeout,
        maxTimeout: options.maxTimeout,
      })
    },
    dispose: () => {
      core.configureReconnect(null)
    },
  })
}
