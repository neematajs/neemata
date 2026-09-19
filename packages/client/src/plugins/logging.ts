import type { ClientPlugin, ClientPluginEvent } from './types.ts'

export interface LoggingPluginOptions {
  includeBodies?: boolean
  onEvent(event: ClientPluginEvent): void | Promise<void>
  mapEvent?(event: ClientPluginEvent): ClientPluginEvent | null
  onSinkError?(error: unknown, event: ClientPluginEvent): void
}

const stripBody = (event: ClientPluginEvent): ClientPluginEvent => {
  if (!('body' in event)) return event

  const { body: _body, ...rest } = event
  return rest
}

export const loggingPlugin = (options: LoggingPluginOptions): ClientPlugin => {
  const includeBodies = options.includeBodies ?? false

  return () => ({
    name: 'logging',
    onClientEvent: (event) => {
      const logged = includeBodies ? event : stripBody(event)
      const mapped = options.mapEvent ? options.mapEvent(logged) : logged

      if (!mapped) return

      try {
        const result = options.onEvent(mapped)
        Promise.resolve(result).catch((error) => {
          options.onSinkError?.(error, mapped)
        })
      } catch (error) {
        options.onSinkError?.(error, mapped)
      }
    },
  })
}
