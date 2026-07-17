import type { ApplicationTransport } from '@nmtjs/application'
import type { ConnectionType } from '@nmtjs/protocol'
import { ProxyableTransportType } from '@nmtjs/gateway'
import createAdapter from 'crossws/adapters/uws'
import { App, SSLApp, us_socket_local_port } from 'uWebSockets.js'

import type {
  WsAdapterParams,
  WsAdapterServer,
  WsTransportOptions,
  WsTransportRuntimeNode,
} from '../types.ts'
import * as injectables from '../injectables.ts'
import { createWSTransportWorker } from '../server.ts'
import { StatusResponse } from '../utils.ts'

const statusResponse = StatusResponse()
const statusResponseBuffer = await statusResponse.arrayBuffer()

/**
 * uWS defaults to 16KiB and CLOSES the socket on larger frames — the
 * gateway's own upload credit grants (64KiB) plus the 5-byte frame header
 * already exceed that, killing every blob upload. Inline WS payloads are
 * capped here at 1 MiB by design: larger data should ride blob streams,
 * which are chunked at credit size.
 */
export const DEFAULT_WS_MAX_PAYLOAD = 1024 * 1024
/**
 * uWS defaults to 64KiB and DROPS frames above it — the same order of
 * magnitude as outstanding stream credit; a higher ceiling keeps
 * abort-on-drop a safety net, not a common path.
 */
export const DEFAULT_WS_MAX_BACKPRESSURE = 1024 * 1024

/**
 * ?? per field instead of spread-defaults: an explicitly-undefined user
 * value (e.g. from an optional env var) must not erase the framework
 * defaults and resurrect uWS's frame-killing 16KiB/64KiB limits.
 */
export function resolveUwsWsOptions(ws?: WsTransportRuntimeNode['ws']) {
  return {
    ...ws,
    maxPayloadLength: ws?.maxPayloadLength ?? DEFAULT_WS_MAX_PAYLOAD,
    maxBackpressure: ws?.maxBackpressure ?? DEFAULT_WS_MAX_BACKPRESSURE,
  }
}

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
      ...resolveUwsWsOptions(params.runtime?.ws),
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
