import type { ClientPlugin, ReconnectPluginOptions } from './types.ts'

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
