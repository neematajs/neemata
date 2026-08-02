import type { ApplicationTransport } from '@nmtjs/application'
import type { ConnectionType } from '@nmtjs/protocol'
import { ProxyableTransportType } from '@nmtjs/gateway'
import { createServerHost } from '@nmtjs/server/bun'

import type { WsAdapterParams, WsTransportOptions } from '../types.ts'
import { createHostAdapter } from '../adapter.ts'
import * as injectables from '../injectables.ts'
import { createWSTransportWorker } from '../server.ts'

function adapterFactory(params: WsAdapterParams<'bun'>) {
  return createHostAdapter(createServerHost, params)
}

export const WsTransport: ApplicationTransport<
  ConnectionType.Bidirectional,
  WsTransportOptions<'bun'>,
  typeof injectables,
  ProxyableTransportType.WS
> = {
  proxyable: ProxyableTransportType.WS,
  injectables,
  factory(options) {
    return createWSTransportWorker(adapterFactory, options)
  },
}
