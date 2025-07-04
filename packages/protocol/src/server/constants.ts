export const kTransportPlugin: unique symbol = Symbol.for(
  'neemata:TransportPluginKey',
)
export type kTransportPlugin = typeof kTransportPlugin

export const kIterableResponse: unique symbol = Symbol.for(
  'neemata:IterableResponseKey',
)
export type kIterableResponse = typeof kIterableResponse
