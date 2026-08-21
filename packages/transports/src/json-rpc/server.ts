import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'

import type {
  GatewayConnection,
  GatewayResolvedProcedure,
  TransportWorkerParams,
} from '@nmtjs/gateway'
import { anyAbortSignal, isAsyncIterable } from '@nmtjs/common'
import { ProxyableTransportType } from '@nmtjs/gateway'
import { ConnectionType, ProtocolBlob, ProtocolVersion } from '@nmtjs/protocol'
import { ProtocolError, UnsupportedFormatError } from '@nmtjs/protocol/server'

import type { ServerHandler } from '../transport.ts'
import type {
  JsonRpcErrorObject,
  JsonRpcHandlerOptions,
  JsonRpcId,
  JsonRpcResponse,
} from './types.ts'
import { PayloadTooLargeError } from '../http/utils.ts'
import {
  BATCH_CONCURRENCY,
  DEFAULT_MAX_BATCH_SIZE,
  JSON_RPC_METHOD_PATTERN,
  JsonRpcErrorCode,
  ProtocolToJsonRpcCode,
  SELECTION_PATTERN,
} from './constants.ts'

const JSON_CONTENT_TYPE = 'application/json'

export function jsonRpc(): ServerHandler<
  ConnectionType.Unidirectional,
  JsonRpcHandlerOptions,
  {},
  readonly [ProxyableTransportType.HTTP]
> {
  return {
    proxyable: [ProxyableTransportType.HTTP],
    mount({ host, gateway }, options) {
      if (
        options.maxRequestBodySize !== undefined &&
        options.maxRequestBodySize > host.maxRequestBodySize
      ) {
        throw new Error(
          `JSON-RPC handler maxRequestBodySize (${options.maxRequestBodySize}) ` +
            `exceeds the host limit (${host.maxRequestBodySize})`,
        )
      }
      const handler = new JsonRpcHandler(
        gateway,
        options,
        host.maxRequestBodySize,
      )
      const unmount = host.mountFetchHandler({
        path: options.path,
        handler: handler.handle.bind(handler),
      })
      return { dispose: unmount }
    },
  }
}

export class JsonRpcHandler {
  #maxBatchSize: number
  #maxRequestBodySize: number
  #include?: string[]
  #exclude?: string[]

  constructor(
    readonly params: TransportWorkerParams<
      ConnectionType.Unidirectional,
      GatewayResolvedProcedure
    >,
    readonly options: JsonRpcHandlerOptions,
    hostMaxRequestBodySize = Number.POSITIVE_INFINITY,
  ) {
    this.#maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE
    if (!Number.isInteger(this.#maxBatchSize) || this.#maxBatchSize < 1) {
      throw new Error('maxBatchSize must be a positive integer')
    }
    this.#maxRequestBodySize =
      options.maxRequestBodySize ?? hostMaxRequestBodySize
    this.#include = validateSelection('include', options.include)
    this.#exclude = validateSelection('exclude', options.exclude)
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response(null, {
        status: 405,
        headers: { Allow: 'POST' },
      })
    }

    const controller = new AbortController()
    const signal = anyAbortSignal(request.signal, controller.signal)

    let connection: (GatewayConnection & AsyncDisposable) | undefined
    try {
      connection = await this.params.onConnect({
        accept: JSON_CONTENT_TYPE,
        contentType: JSON_CONTENT_TYPE,
        data: request,
        protocolVersion: ProtocolVersion.v1,
        type: ConnectionType.Unidirectional,
      })
    } catch (error) {
      if (error instanceof UnsupportedFormatError) {
        // The gateway has no JSON format registered — the handler cannot
        // speak JSON-RPC at all
        return new Response(null, { status: 415 })
      }
      throw error
    }

    await using _connection = connection

    let body: Buffer
    try {
      body = await this.readBody(request)
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return new Response(null, { status: 413 })
      }
      throw error
    }

    let envelope: unknown
    try {
      if (body.byteLength === 0) throw new Error('Empty body')
      envelope = connection.decoder.decode(body)
    } catch {
      return this.respond(connection, {
        jsonrpc: '2.0',
        id: null,
        error: { code: JsonRpcErrorCode.ParseError, message: 'Parse error' },
      })
    }

    if (Array.isArray(envelope)) {
      if (envelope.length === 0) {
        return this.respond(connection, invalidRequest(null, 'Empty batch'))
      }
      if (envelope.length > this.#maxBatchSize) {
        return this.respond(
          connection,
          invalidRequest(
            null,
            `Batch size exceeds the limit of ${this.#maxBatchSize}`,
          ),
        )
      }
      const results = await runWithConcurrency(
        envelope,
        BATCH_CONCURRENCY,
        (entry, index) => this.runEntry(connection, entry, index, signal),
      )
      const responses = results.filter(
        (response): response is JsonRpcResponse => response !== undefined,
      )
      // A batch of nothing but notifications gets no response body
      if (responses.length === 0) return new Response(null, { status: 204 })
      return this.respond(connection, responses)
    }

    const response = await this.runEntry(connection, envelope, 0, signal)
    if (response === undefined) return new Response(null, { status: 204 })
    return this.respond(connection, response)
  }

  private async runEntry(
    connection: GatewayConnection,
    entry: unknown,
    callId: number,
    signal: AbortSignal,
  ): Promise<JsonRpcResponse | undefined> {
    const validation = validateEntry(entry)
    if ('error' in validation) return validation.error

    const { id, method, params, notification } = validation

    try {
      const procedure = this.selectProcedure(method)
      const resolved = await this.params.resolve(connection, procedure)
      // Stream routes are not part of the JSON-RPC projection
      if (resolved.stream) throw new ProtocolError('NotFound')

      const result = await this.params.onRpc(
        connection,
        { callId, payload: params, procedure },
        signal,
      )

      if (notification) return undefined

      if (
        result instanceof Response ||
        result instanceof ProtocolBlob ||
        isAsyncIterable(result)
      ) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: JsonRpcErrorCode.InternalError,
            message: 'Result is not representable in JSON-RPC',
          },
        }
      }

      // `result` is REQUIRED on success; void procedures answer with null
      return {
        jsonrpc: '2.0',
        id,
        result: result === undefined ? null : result,
      }
    } catch (error) {
      if (notification) return undefined
      return { jsonrpc: '2.0', id, error: mapError(error) }
    }
  }

  /** JSON-RPC method → native procedure name, applying selection rules. */
  private selectProcedure(method: string): string {
    if (!JSON_RPC_METHOD_PATTERN.test(method)) {
      throw new ProtocolError('NotFound')
    }
    const name = method.replaceAll('.', '/')
    if (this.#include && !this.#include.some((p) => matches(p, name))) {
      throw new ProtocolError('NotFound')
    }
    if (this.#exclude?.some((p) => matches(p, name))) {
      throw new ProtocolError('NotFound')
    }
    return name
  }

  private respond(connection: GatewayConnection, payload: unknown): Response {
    const buffer = connection.encoder.encode(payload)
    return new Response(buffer as BodyInit, {
      status: 200,
      headers: { 'Content-Type': connection.encoder.contentType },
    })
  }

  private async readBody(request: Request): Promise<Buffer> {
    if (!request.body) return Buffer.alloc(0)
    const declaredSize = request.headers.get('content-length')
    if (
      declaredSize !== null &&
      Number.parseInt(declaredSize, 10) > this.#maxRequestBodySize
    ) {
      throw new PayloadTooLargeError()
    }
    const chunks: Buffer[] = []
    let received = 0
    for await (const chunk of Readable.fromWeb(request.body as any)) {
      received += chunk.byteLength
      // Enforce the cap even when the declared content-length lies
      if (received > this.#maxRequestBodySize) throw new PayloadTooLargeError()
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
}

export type ValidatedEntry =
  | { error: JsonRpcResponse }
  | {
      id: JsonRpcId
      method: string
      params: unknown
      notification: boolean
    }

export function validateEntry(entry: unknown): ValidatedEntry {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return { error: invalidRequest(null) }
  }
  const { jsonrpc, method, params } = entry as Record<string, unknown>
  const notification = !('id' in entry)
  const rawId = notification ? null : (entry as Record<string, unknown>).id

  if (
    rawId !== null &&
    typeof rawId !== 'string' &&
    typeof rawId !== 'number'
  ) {
    return { error: invalidRequest(null, 'Invalid id') }
  }
  const id = rawId as JsonRpcId

  if (jsonrpc !== '2.0') {
    return { error: invalidRequest(notification ? null : id) }
  }
  if (typeof method !== 'string') {
    return { error: invalidRequest(notification ? null : id) }
  }
  if (params !== undefined && (typeof params !== 'object' || params === null)) {
    return {
      error: {
        jsonrpc: '2.0',
        id: notification ? null : id,
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          message: 'Params must be a structured value',
        },
      },
    }
  }

  return { id, method, params, notification }
}

function invalidRequest(id: JsonRpcId, message = 'Invalid Request') {
  return {
    jsonrpc: '2.0',
    id,
    error: { code: JsonRpcErrorCode.InvalidRequest, message },
  } satisfies JsonRpcResponse
}

export function mapError(error: unknown): JsonRpcErrorObject {
  if (error instanceof ProtocolError) {
    const code =
      ProtocolToJsonRpcCode[error.code] ?? JsonRpcErrorCode.InternalError
    return {
      code,
      message: error.message || error.code,
      data:
        error.data === undefined
          ? { code: error.code }
          : { code: error.code, data: error.data },
    }
  }
  console.error(error)
  return {
    code: JsonRpcErrorCode.InternalError,
    message: 'Internal error',
  }
}

function validateSelection(kind: string, patterns?: string[]) {
  if (patterns === undefined) return undefined
  for (const pattern of patterns) {
    if (!SELECTION_PATTERN.test(pattern)) {
      throw new Error(`Invalid ${kind} pattern "${pattern}"`)
    }
  }
  return patterns
}

function matches(pattern: string, name: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith('/*')) return name.startsWith(pattern.slice(0, -1))
  return pattern === name
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++
        results[index] = await task(items[index], index)
      }
    },
  )
  await Promise.all(workers)
  return results
}
