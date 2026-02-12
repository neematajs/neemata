import type { ClientPlugin, ClientPluginEvent } from './types.ts'

export type ClientLogEvent = ClientPluginEvent

export interface LoggingPluginOptions {
  includeBodies?: boolean
  onEvent(event: ClientLogEvent): void | Promise<void>
  mapEvent?(event: ClientLogEvent): ClientLogEvent | null
  onSinkError?(error: unknown, event: ClientLogEvent): void
}

const stripEventBody = (event: ClientLogEvent): ClientLogEvent => {
  if (!('body' in event)) return event

  const { body: _body, ...rest } = event
  return rest as ClientLogEvent
}

export const loggingPlugin = (options: LoggingPluginOptions): ClientPlugin => {
  const includeBodies = options.includeBodies ?? false

  return () => ({
    name: 'logging',
    onClientEvent: (event) => {
      const eventToMap = includeBodies ? event : stripEventBody(event)
      const mappedEvent = options.mapEvent
        ? options.mapEvent(eventToMap)
        : eventToMap

      if (!mappedEvent) return

      try {
        const sinkResult = options.onEvent(mappedEvent)
        Promise.resolve(sinkResult).catch((error) => {
          options.onSinkError?.(error, mappedEvent)
        })
      } catch (error) {
        options.onSinkError?.(error, mappedEvent)
      }
    },
  })
}
