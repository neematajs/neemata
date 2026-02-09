import type { Transport } from '@nmtjs/gateway'
import type { ConnectionType } from '@nmtjs/protocol'
import { ProxyableTransportType } from '@nmtjs/gateway'
import createAdapter from 'crossws/adapters/uws'

import type {
  WsAdapterParams,
  WsAdapterServer,
  WsTransportOptions,
} from '../types.ts'
import * as injectables from '../injectables.ts'
import { createWSTransportWorker } from '../server.ts'
import { StatusResponse } from '../utils.ts'

import { App, SSLApp, us_socket_local_port } from 'uWebSockets.js'

const statusResponse = StatusResponse()
const statusResponseBuffer = await statusResponse.arrayBuffer()

function adapterFactory(params: WsAdapterParams<'node'>): WsAdapterServer {
  const adapter = createAdapter({ hooks: params.wsHooks })

  const server = params.tls
    ? SSLApp({
        passphrase: params.tls.passphrase,
        key_file_name: params.tls.key,
        cert_file_name: params.tls.cert,
      })
    : App()

  server
    .ws('/*', { ...params.runtime?.ws, ...adapter.websocket })
    .get('/healthy', (res) => {
      res.cork(() => {
        res
          .writeStatus(`${statusResponse.status} ${statusResponse.statusText}`)
          .end(statusResponseBuffer)
      })
    })

  return {
    start: () =>
      new Promise<string>((resolve, reject) => {
        const proto = params.tls ? 'https' : 'http'
        if (params.listen.unix) {
          server.listen_unix((socket) => {
            if (socket) {
              resolve(`${proto}+unix://` + params.listen.unix)
            } else {
              reject(new Error('Failed to start WebSockets server'))
            }
          }, params.listen.unix)
        } else if (typeof params.listen.port === 'number') {
          const hostname = params.listen.hostname || '127.0.0.1'
          server.listen(hostname, params.listen.port, (socket) => {
            if (socket) {
              resolve(`${proto}://${hostname}:${us_socket_local_port(socket)}`)
            } else {
              reject(new Error('Failed to start WebSockets server'))
            }
          })
        } else {
          reject(new Error('Invalid listen parameters'))
        }
      }),
    stop: () => {
      server.close()
    },
  }
}

export const WsTransport: Transport<
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
