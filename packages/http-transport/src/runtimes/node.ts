import {} from 'node:dns'
import { setTimeout } from 'node:timers/promises'

import type { TransportV2 } from '@nmtjs/gateway'
import type { ConnectionType } from '@nmtjs/protocol'
import { ProxyableTransportType } from '@nmtjs/gateway'

import type {
  HttpAdapterParams,
  HttpAdapterServer,
  HttpTransportOptions,
} from '../types.ts'
import * as injectables from '../injectables.ts'
import { createHTTPTransportWorker } from '../server.ts'
import {
  InternalServerErrorHttpResponse,
  NotFoundHttpResponse,
  StatusResponse,
} from '../utils.ts'

import { App, SSLApp, us_socket_local_port } from 'uWebSockets.js'

function adapterFactory(params: HttpAdapterParams<'node'>): HttpAdapterServer {
  const server = params.tls
    ? SSLApp({
        passphrase: params.tls.passphrase,
        key_file_name: params.tls.key,
        cert_file_name: params.tls.cert,
      })
    : App()

  server
    .get('/healthy', async (res) => {
      res.onAborted(() => {})
      const response = StatusResponse()
      res.cork(async () => {
        res
          .writeStatus(`${response.status} ${response.statusText}`)
          .end(await response.arrayBuffer())
      })
    })
    .any('/*', async (res, req) => {
      const controller = new AbortController()
      res.onAborted(() => {
        console.dir('Request aborted by client')
        res.aborted = true
        controller.abort()
      })

      let response = NotFoundHttpResponse()

      const headers = new Headers()
      const method = req.getMethod()
      req.forEach((k, v) => headers.append(k, v))

      const host = headers.get('host') || 'localhost'
      const proto =
        headers.get('x-forwarded-proto') || params.tls ? 'https' : 'http'
      const url = new URL(req.getUrl(), `${proto}://${host}`)

      try {
        const body = new ReadableStream({
          start(controller) {
            res.onData((chunk, isLast) => {
              if (chunk) {
                const copy = Buffer.allocUnsafe(chunk.byteLength)
                copy.set(new Uint8Array(chunk))
                controller.enqueue(copy)
              }
              if (isLast) controller.close()
            })
            res.onAborted(() => controller.error())
          },
        })
        response = await params.fetchHandler(
          { url, method, headers },
          body,
          controller.signal,
        )
      } catch (err) {
        // TODO: proper logging
        console.error(err)
        // params.logger.error({ err }, 'Error in fetch handler')
        response = InternalServerErrorHttpResponse()
      }
      if (res.aborted) return undefined
      else {
        res.cork(() => {
          if (res.aborted) return undefined
          res.writeStatus(
            `${response.status.toString()} ${response.statusText}`,
          )
          response.headers.forEach((v, k) => res.writeHeader(k, v))
        })
        if (response.body) {
          try {
            const reader = response.body.getReader()
            let chunk = await reader.read()
            do {
              if (res.aborted) break
              if (chunk.value) res.write(chunk.value)
              chunk = await reader.read()
            } while (!chunk.done)
            if (!res.aborted) res.end()
          } catch {
            if (!res.aborted) res.close()
          }
        } else {
          if (!res.aborted) res.end()
        }
      }
    })

  return {
    runtime: { node: server },
    start: () =>
      new Promise<string>((resolve, reject) => {
        if (params.listen.unix) {
          server.listen_unix((socket) => {
            if (socket) {
              resolve('unix://' + params.listen.unix)
            } else {
              reject(new Error('Failed to start WebSockets server'))
            }
          }, params.listen.unix)
        } else if (typeof params.listen.port === 'number') {
          const proto = params.tls ? 'https' : 'http'
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

export const HttpTransport: TransportV2<
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
