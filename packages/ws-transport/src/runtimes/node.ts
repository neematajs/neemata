import type { ApplicationTransport } from '@nmtjs/application'
import type { ConnectionType } from '@nmtjs/protocol'
import { ProxyableTransportType } from '@nmtjs/gateway'
import { createServerHost } from '@nmtjs/server/node'

import type { WsAdapterParams, WsTransportOptions } from '../types.ts'
import { createHostAdapter } from '../adapter.ts'
import * as injectables from '../injectables.ts'
import { createWSTransportWorker } from '../server.ts'

// re-exported for compat: the uWS behavior defaults are applied by the
// shared server host, but they remain part of this transport's public API
export {
  DEFAULT_WS_MAX_BACKPRESSURE,
  DEFAULT_WS_MAX_PAYLOAD,
  resolveUwsWsOptions,
} from '@nmtjs/server/node'

function adapterFactory(params: WsAdapterParams<'node'>) {
  return createHostAdapter(createServerHost, params)
}

export const WsTransport: ApplicationTransport<
  ConnectionType.Bidirectional,
  WsTransportOptions<'node'>,
  typeof injectables,
  ProxyableTransportType.WS
> = {
  proxyable: ProxyableTransportType.WS,
  injectables,
  factory(options) {
    return createWSTransportWorker(adapterFactory, options)
  },
}
