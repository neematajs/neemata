import type { ApplicationTransport } from '@nmtjs/application'
import type { ConnectionType } from '@nmtjs/protocol'
import { ProxyableTransportType } from '@nmtjs/gateway'
import createAdapter from 'crossws/adapters/uws'
import { App, SSLApp, us_socket_local_port } from 'uWebSockets.js'

import type {
  WsAdapterParams,
  WsAdapterServer,
  WsTransportOptions,
} from '../types.ts'
import * as injectables from '../injectables.ts'
import { createWSTransportWorker } from '../server.ts'
import { StatusResponse } from '../utils.ts'

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
    .ws('/*', {
      // uWS defaults to 64KB and DROPS frames above it — the same order of
      // magnitude as outstanding stream credit; raise the ceiling so
      // abort-on-drop stays a safety net (user-provided options still win)
      maxBackpressure: 1024 * 1024,
      // uWS defaults to 16KB and CLOSES the socket on larger frames — the
      // gateway's own upload credit grants (16KiB) plus the 5-byte frame
      // header already exceed that, killing every blob upload
      maxPayloadLength: 1024 * 1024,
      ...params.runtime?.ws,
      ...adapter.websocket,
    })
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
    // uWS send status: 1 = sent, 0 = buffered (will drain), 2 = dropped
    // due to backpressure limit — only a drop is a failed delivery
    isSendSuccess: (status) => status !== 2,
  }
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
