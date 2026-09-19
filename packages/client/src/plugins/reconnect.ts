import type { ClientPlugin, ReconnectConfig } from './types.ts'

export const reconnectPlugin = (
  options: ReconnectConfig = {},
): ClientPlugin => {
  return ({ core }) => ({
    name: 'reconnect',
    onInit: () => {
      core.configureReconnect(options)
    },
    dispose: () => {
      core.configureReconnect(null)
    },
  })
}
