import type { ApplicationTransport } from '@nmtjs/application'
import type { ConnectionType } from '@nmtjs/protocol'
import { ProxyableTransportType } from '@nmtjs/gateway'
import { createServerHost } from '@nmtjs/server-host/node'

import type { HttpAdapterParams, HttpTransportOptions } from '../types.ts'
import { createHostAdapter } from '../adapter.ts'
import * as injectables from '../injectables.ts'
import { createHTTPTransportWorker } from '../server.ts'

function adapterFactory(params: HttpAdapterParams<'node'>) {
  return createHostAdapter(createServerHost, params)
}

export const HttpTransport: ApplicationTransport<
  ConnectionType.Unidirectional,
  HttpTransportOptions<'node'>,
  typeof injectables,
  ProxyableTransportType.HTTP
> = {
  proxyable: ProxyableTransportType.HTTP,
  injectables,
  factory(options) {
    return createHTTPTransportWorker(adapterFactory, options)
  },
}
