import { Buffer } from 'node:buffer'

import type { TemplatedApp } from 'uWebSockets.js'
import createAdapter from 'crossws/adapters/uws'
import { App, SSLApp, us_socket_local_port } from 'uWebSockets.js'

import type {
  ServerFetchHandler,
  ServerHost,
  ServerHostOptions,
  ServerNativeHandles,
  ServerWebSocketRuntimeOptions,
} from './types.ts'
import { BaseServerHost } from './host.ts'
import {
  InternalServerErrorHttpResponse,
  NotFoundHttpResponse,
  PayloadTooLargeError,
  PayloadTooLargeHttpResponse,
} from './utils.ts'

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
export function resolveUwsWsOptions(
  ws?: ServerWebSocketRuntimeOptions['node'],
) {
  return {
    ...ws,
    maxPayloadLength: ws?.maxPayloadLength ?? DEFAULT_WS_MAX_PAYLOAD,
    maxBackpressure: ws?.maxBackpressure ?? DEFAULT_WS_MAX_BACKPRESSURE,
  }
}

type UwsResponse = Parameters<
  Parameters<ReturnType<typeof App>['any']>[1]
>[0] & {
  aborted?: boolean
  wakeWritable?: () => void
  cancelBody?: () => void
}

class NodeServerHost extends BaseServerHost<'node'> {
  readonly runtime = 'node' as const
  #server: TemplatedApp | null = null

  get native(): ServerNativeHandles {
    return { node: this.#server ?? undefined }
  }

  // uWS send status: 1 = sent, 0 = buffered (will drain), 2 = dropped
  // due to backpressure limit — only a drop is a failed delivery
  override isSendSuccess(status: number): boolean {
    return status !== 2
  }

  protected override get effectiveWsMaxPayloadLength(): number | undefined {
    return resolveUwsWsOptions(this.options.webSocket).maxPayloadLength
  }

  protected bind(): Promise<string> {
    const server = this.options.tls
      ? SSLApp({
          passphrase: this.options.tls.passphrase,
          key_file_name: this.options.tls.key,
          cert_file_name: this.options.tls.cert,
        })
      : App()

    if (this.hasWebSockets) {
      const adapter = createAdapter(this.createWsAdapterConfig())
      server.ws('/*', {
        ...resolveUwsWsOptions(this.options.webSocket),
        ...adapter.websocket,
      })
    }

    server.any('/*', (res, req) => this.handleRequest(res as UwsResponse, req))

    return new Promise<string>((resolve, reject) => {
      const { listen, tls } = this.options
      const proto = tls ? 'https' : 'http'
      if (listen.unix) {
        server.listen_unix((socket) => {
          if (socket) {
            this.#server = server
            resolve(`${proto}+unix://${listen.unix}`)
          } else {
            reject(new Error('Failed to start server'))
          }
        }, listen.unix)
      } else if (typeof listen.port === 'number') {
        const hostname = listen.hostname || '127.0.0.1'
        server.listen(hostname, listen.port, (socket) => {
          if (socket) {
            this.#server = server
            resolve(`${proto}://${hostname}:${us_socket_local_port(socket)}`)
          } else {
            reject(new Error('Failed to start server'))
          }
        })
      } else {
        reject(new Error('Invalid listen parameters'))
      }
    })
  }

  protected async close(): Promise<void> {
    this.#server?.close()
    this.#server = null
  }

  private async handleRequest(
    uwsRes: UwsResponse,
    req: Parameters<Parameters<TemplatedApp['any']>[1]>[1],
  ) {
    const res = uwsRes
    const requestController = new AbortController()
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

    const headers = new Headers()
    const method = req.getMethod()
    req.forEach((k, v) => headers.append(k, v))

    const host = headers.get('host') || 'localhost'
    const forwardedProto = headers.get('x-forwarded-proto')
    const proto = forwardedProto
      ? forwardedProto === 'https'
        ? 'https'
        : 'http'
      : this.options.tls
        ? 'https'
        : 'http'
    const url = new URL(req.getUrl(), `${proto}://${host}`)
    url.search = req.getQuery() ? `?${req.getQuery()}` : ''

    let response: Response
    // Upgrade requests reach here only when no WebSocket route is mounted (a
    // mounted ws route claims them inside uWS) — the shared router still
    // answers reserved paths and 404s the rest, like the other runtimes
    if (headers.get('upgrade') === 'websocket') {
      response = this.respondToUpgrade(url.pathname)
    } else {
      const route = this.route(url.pathname, false)
      if (route.kind === 'reserved') {
        response = route.respond()
      } else if (route.kind === 'fetch') {
        response = await this.handleFetchRequest(
          route.handler,
          { url, method, headers },
          res,
          requestController.signal,
          (controller) => {
            bodyController = controller
          },
          () => aborted,
        )
      } else {
        response = NotFoundHttpResponse()
      }
    }

    if (aborted) return undefined
    else {
      const fixedContentLength = response.body
        ? getContentLength(response.headers)
        : undefined
      res.cork(() => {
        if (aborted) return undefined
        res.writeStatus(`${response.status.toString()} ${response.statusText}`)
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
  }

  private async handleFetchRequest(
    handler: ServerFetchHandler,
    request: { url: URL; method: string; headers: Headers },
    res: UwsResponse,
    signal: AbortSignal,
    onBodyController: (
      controller: ReadableStreamDefaultController<Buffer>,
    ) => void,
    isAborted: () => boolean,
  ): Promise<Response> {
    const maxBodySize = this.maxRequestBodySize
    try {
      if (request.method === 'get' || request.method === 'head') {
        return await handler(
          new Request(request.url, {
            method: request.method,
            headers: request.headers,
            signal,
          }),
        )
      }

      // uWS delivers chunks without backpressure, so cap what gets copied
      // into memory before the whole body arrives
      let received = 0
      let capped = false
      const body = new ReadableStream<Buffer>({
        start(controller) {
          onBodyController(controller)
          res.onDataV2((chunk, maxRemainingBodyLength) => {
            if (isAborted() || capped) return
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
      // Node requires duplex when a Request body is backed by a stream.
      const init: RequestInit & { duplex: 'half' } = {
        method: request.method,
        headers: request.headers,
        body,
        signal,
        duplex: 'half',
      }
      return await handler(new Request(request.url, init))
    } catch (err) {
      // a tenant that consumed the capped body without mapping the error
      // itself must still produce a 413, not a generic 500
      if (err instanceof PayloadTooLargeError) {
        return PayloadTooLargeHttpResponse()
      }
      // TODO: proper logging
      console.error(err)
      return InternalServerErrorHttpResponse()
    }
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

// uWS honors only the first onWritable registration per response, so a single
// handler dispatches drain (and abort) events to the pending waiter
function createWritableWaiter(res: UwsResponse): () => Promise<void> {
  let writableHandlerRegistered = false
  return () =>
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
}

// exported for tests: the waiter dispatch is timing-sensitive and needs
// deterministic coverage against a controlled response double
export async function handleFixedLengthStream(
  res: UwsResponse,
  body: ReadableStream<Uint8Array>,
  totalSize: number,
): Promise<void> {
  const reader = body.getReader()
  // abort must also cancel a pending read(): a stalled source would otherwise
  // keep the pump and the reader lock alive forever
  res.cancelBody = () => {
    reader.cancel().catch(() => {})
  }
  const waitWritable = createWritableWaiter(res)
  try {
    if (totalSize === 0) {
      if (!res.aborted) res.cork(() => res.endWithoutBody(0))
      return
    }

    while (!res.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.byteLength === 0) continue
      if (await handleFixedChunk(res, value, totalSize, waitWritable)) return
    }

    if (!res.aborted) res.cork(() => res.close())
  } finally {
    res.cancelBody = undefined
    // non-abort early exits (zero-length response, tryEnd done while the
    // source is still open) must also cancel the source so its resources are
    // released; no-op when the stream already closed or was cancelled on abort
    reader.cancel().catch(() => {})
    reader.releaseLock()
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
  const waitWritable = createWritableWaiter(res)
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

async function handleFixedChunk(
  res: UwsResponse,
  chunk: Uint8Array,
  totalSize: number,
  waitWritable: () => Promise<void>,
): Promise<boolean> {
  const chunkOffset = res.getWriteOffset()

  while (true) {
    if (res.aborted) throw new Error('Response aborted')

    // on retry after a drain the write offset tells how much of this chunk
    // uWS already buffered
    const relativeOffset = res.getWriteOffset() - chunkOffset
    const remaining =
      relativeOffset > 0 ? chunk.subarray(relativeOffset) : chunk

    // cork() returns the response object, not tryEnd()'s flags
    let ok = false
    let done = false
    res.cork(() => {
      ;[ok, done] = res.tryEnd(remaining, totalSize)
    })

    if (done || ok) return done
    await waitWritable()
  }
}

function getContentLength(headers: Headers): number | undefined {
  const raw = headers.get('content-length')
  if (!raw) return undefined

  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function createServerHost(
  options: ServerHostOptions<'node'>,
): ServerHost<'node'> {
  return new NodeServerHost(options)
}
