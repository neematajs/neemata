import { App, SSLApp } from 'uWebSockets.js'
import { createTransport } from '@nmtjs/protocol/server'
import createAdapter from 'crossws/adapters/uws'
import { WsTransportServer } from '../server.ts'
import type {
  WsAdapterParams,
  WsAdapterServer,
  WsConnectionData,
  WsTransportOptions,
} from '../types.ts'
import {
  InternalServerErrorHttpResponse,
  NotFoundHttpResponse,
} from '../utils.ts'

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
    .ws(params.apiPath, {
      ...params.runtime?.ws,
      ...adapter.websocket,
    })
    .any('/*', async (res, req) => {
      const controller = new AbortController()
      res.onAborted(() => controller.abort())

      let response = NotFoundHttpResponse()

      const headers = new Headers()
      const method = req.getMethod()
      req.forEach((k, v) => headers.append(k, v))

      const host = headers.get('host') || 'localhost'
      const proto = headers.get('x-forwarded-proto') || 'http'
      const url = new URL(req.getUrl(), `${proto}://${host}`)

      if (url.pathname.startsWith(params.apiPath)) {
        try {
          const body = new ReadableStream({
            start(controller) {
              res.onData((chunk, isLast) => {
                if (chunk) controller.enqueue(chunk.slice(0))
                if (isLast) controller.close()
              })
              res.onAborted(() => controller.error())
            },
          })
          response = await params.fetchHandler(
            {
              url,
              method,
              headers,
            },
            body,
            controller.signal,
          )
        } catch {
          response = InternalServerErrorHttpResponse()
        }
      }
      if (controller.signal.aborted) return undefined
      else {
        res.cork(() => {
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
              if (controller.signal.aborted) break
              if (chunk.value) res.write(chunk.value)
              chunk = await reader.read()
            } while (!chunk.done)
            res.end()
          } catch {
            res.close()
          }
        } else {
          res.end()
        }
      }
    })

  return {
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
              resolve(`${proto}://${hostname}:${params.listen.port}`)
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

export const WsTransport = createTransport<
  WsConnectionData,
  WsTransportOptions<'node'>
>('WsTransport', (context, options) => {
  return new WsTransportServer(adapterFactory, context, options)
})
