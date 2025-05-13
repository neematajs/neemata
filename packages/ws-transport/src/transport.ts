import { createTransport } from '@nmtjs/protocol/server'
import { WsTransportServer } from './server.ts'
import type { WsConnectionData, WsTransportOptions } from './types.ts'

export const WsTransport = createTransport<
  WsConnectionData,
  WsTransportOptions
>('WsTransport', (context, options) => {
  return new WsTransportServer(context, options)
})
