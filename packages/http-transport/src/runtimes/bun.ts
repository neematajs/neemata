import type { ApplicationTransport } from '@nmtjs/application'
import type { ConnectionType } from '@nmtjs/protocol'
import { ProxyableTransportType } from '@nmtjs/gateway'
import { createServerHost } from '@nmtjs/server/bun'

import type { HttpAdapterParams, HttpTransportOptions } from '../types.ts'
import { createHostAdapter } from '../adapter.ts'
import * as injectables from '../injectables.ts'
import { createHTTPTransportWorker } from '../server.ts'

function adapterFactory(params: HttpAdapterParams<'bun'>) {
  return createHostAdapter(createServerHost, params)
}

export const HttpTransport: ApplicationTransport<
  ConnectionType.Unidirectional,
  HttpTransportOptions<'bun'>,
  typeof injectables,
  ProxyableTransportType.HTTP
> = {
  proxyable: ProxyableTransportType.HTTP,
  injectables,
  factory(options) {
    return createHTTPTransportWorker(adapterFactory, options)
  },
}
