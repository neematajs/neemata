import { createTransport } from '@nmtjs/protocol/server'
import { type WsConnectionData, WsTransportServer } from './server.ts'
import type { WsTransportOptions } from './types.ts'

export const WsTransport = createTransport<
  WsConnectionData,
  WsTransportOptions
>('WsTransport', (context, options) => {
  return new WsTransportServer(context, options)
})
