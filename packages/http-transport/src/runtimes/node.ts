import {} from 'node:dns'

import type { ApplicationTransport } from '@nmtjs/application'
import type { ConnectionType } from '@nmtjs/protocol'
import { ProxyableTransportType } from '@nmtjs/gateway'
import { App, SSLApp, us_socket_local_port } from 'uWebSockets.js'

import type {
  HttpAdapterParams,
  HttpAdapterServer,
  HttpTransportOptions,
} from '../types.ts'
import { DEFAULT_MAX_REQUEST_BODY_SIZE } from '../constants.ts'
import * as injectables from '../injectables.ts'
import { createHTTPTransportWorker } from '../server.ts'
import {
  InternalServerErrorHttpResponse,
  NotFoundHttpResponse,
  OkResponse,
  PayloadTooLargeError,
} from '../utils.ts'

const statusResponse = OkResponse()
const statusResponseBuffer = await statusResponse.arrayBuffer()

type UwsResponse = Parameters<
  Parameters<ReturnType<typeof App>['any']>[1]
>[0] & {
  aborted?: boolean
  wakeWritable?: () => void
  cancelBody?: () => void
}

function adapterFactory(params: HttpAdapterParams<'node'>): HttpAdapterServer {
  const maxBodySize = params.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY_SIZE
  const server = params.tls
    ? SSLApp({
        passphrase: params.tls.passphrase,
        key_file_name: params.tls.key,
        cert_file_name: params.tls.cert,
      })
    : App()

  server
    .get('/healthy', (res) => {
      res.cork(() => {
        res
          .writeStatus(`${statusResponse.status} ${statusResponse.statusText}`)
          .end(statusResponseBuffer)
      })
    })
    .any('/*', async (res, req) => {
      const requestController = new AbortController()
      const uwsRes = res as UwsResponse
      let aborted = false
      let bodyController: ReadableStreamDefaultController<Buffer> | undefined

      res.onAborted(() => {
        aborted = true
        uwsRes.aborted = true
        uwsRes.wakeWritable?.()
        uwsRes.cancelBody?.()
        requestController.abort()

        try {
          bodyController?.error(requestController.signal.reason)
        } catch {}
      })

      let response = NotFoundHttpResponse()

      const headers = new Headers()
      const method = req.getMethod()
      req.forEach((k, v) => headers.append(k, v))

      const host = headers.get('host') || 'localhost'
      const forwardedProto = headers.get('x-forwarded-proto')
      const proto = forwardedProto
        ? forwardedProto === 'https'
          ? 'https'
          : 'http'
        : params.tls
          ? 'https'
          : 'http'
      const url = new URL(req.getUrl(), `${proto}://${host}`)
      url.search = req.getQuery() ? `?${req.getQuery()}` : ''
      try {
        // uWS delivers chunks without backpressure, so cap what gets copied
        // into memory before the whole body arrives
        let received = 0
        let capped = false
        const body = new ReadableStream<Buffer>({
          start(controller) {
            bodyController = controller
            res.onDataV2((chunk, maxRemainingBodyLength) => {
              if (aborted || capped) return
              if (chunk) {
                received += chunk.byteLength
                if (received > maxBodySize) {
                  capped = true
                  controller.error(new PayloadTooLargeError())
                  return
                }
                const copy = Buffer.allocUnsafe(chunk.byteLength)
                copy.set(new Uint8Array(chunk))
                controller.enqueue(copy)
              }
              if (maxRemainingBodyLength === 0n) controller.close()
            })
          },
        })
        response = await params.fetchHandler(
          { url, method, headers },
          body,
          requestController.signal,
        )
      } catch (err) {
        // TODO: proper logging
        console.error(err)
        // params.logger.error({ err }, 'Error in fetch handler')
        response = InternalServerErrorHttpResponse()
      }
      if (aborted) return undefined
      else {
        const fixedContentLength = response.body
          ? getContentLength(response.headers)
          : undefined
        res.cork(() => {
          if (aborted) return undefined
          res.writeStatus(
            `${response.status.toString()} ${response.statusText}`,
          )
          response.headers.forEach((v, k) => {
            if (
              typeof fixedContentLength === 'number' &&
              k.toLowerCase() === 'content-length'
            ) {
              return
            }

            res.writeHeader(k, v)
          })
        })
        if (response.body) {
          try {
            await handleResponseBody(uwsRes, response, fixedContentLength)
          } catch {
            if (!aborted) res.cork(() => res.close())
          }
        } else {
          if (!aborted) res.cork(() => res.end())
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

async function handleResponseBody(
  res: UwsResponse,
  response: Response,
  fixedContentLength?: number,
): Promise<void> {
  if (!response.body) return

  if (typeof fixedContentLength === 'number') {
    await handleFixedLengthStream(res, response.body, fixedContentLength)
    return
  }

  await handleChunkedStream(res, response.body)
}

async function handleFixedLengthStream(
  res: UwsResponse,
  body: ReadableStream<Uint8Array>,
  totalSize: number,
): Promise<void> {
  const reader = body.getReader()
  try {
    if (totalSize === 0) {
      if (!res.aborted) res.cork(() => res.endWithoutBody(0))
      return
    }

    let responded = false
    while (!res.aborted && !responded) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.byteLength === 0) continue
      responded = await handleFixedChunk(res, value, totalSize)
    }

    if (!responded && !res.aborted) res.cork(() => res.close())
  } finally {
    // tryEnd reports done without draining the source's final read, so
    // cancel (not just release) — body finalizers rely on a terminal state
    reader.cancel().catch(() => {})
  }
}

// exported for tests: the waiter dispatch is timing-sensitive and needs
// deterministic coverage against a controlled response double
export async function handleChunkedStream(
  res: UwsResponse,
  body: ReadableStream<Uint8Array>,
): Promise<void> {
  const reader = body.getReader()
  // abort must also cancel a pending read(): a stalled source would otherwise
  // keep the pump and the reader lock alive forever
  res.cancelBody = () => {
    reader.cancel().catch(() => {})
  }
  // uWS honors only the first onWritable registration per response, so a
  // single handler dispatches drain (and abort) events to the pending waiter
  let writableHandlerRegistered = false
  const waitWritable = () =>
    new Promise<void>((resolve, reject) => {
      if (!writableHandlerRegistered) {
        writableHandlerRegistered = true
        res.onWritable(() => {
          res.wakeWritable?.()
          return true
        })
      }
      res.wakeWritable = () => {
        res.wakeWritable = undefined
        if (res.aborted) reject(new Error('Response aborted'))
        else resolve()
      }
    })
  try {
    while (!res.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.byteLength === 0) continue

      // cork() returns the response object, not write()'s backpressure flag
      let ok = true
      res.cork(() => {
        ok = res.write(value)
      })
      if (!ok) await waitWritable()
    }

    if (!res.aborted) res.cork(() => res.end())
  } finally {
    res.cancelBody = undefined
    reader.releaseLock()
  }
}

function handleFixedChunk(
  res: UwsResponse,
  chunk: Uint8Array,
  totalSize: number,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const chunkOffset = res.getWriteOffset()

    const write = (offset: number) => {
      if (res.aborted) {
        reject(new Error('Response aborted'))
        return false
      }

      const relativeOffset = offset - chunkOffset
      const remaining =
        relativeOffset > 0 ? chunk.subarray(relativeOffset) : chunk

      let ok = false
      let done = false
      res.cork(() => {
        ;[ok, done] = res.tryEnd(remaining, totalSize)
      })

      if (done || ok) {
        resolve(done)
        return ok
      }

      res.onWritable(write)
      return ok
    }

    write(chunkOffset)
  })
}

function getContentLength(headers: Headers): number | undefined {
  const raw = headers.get('content-length')
  if (!raw) return undefined

  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
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
