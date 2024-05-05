import { Readable } from 'node:stream'
import {
  ApiError,
  ErrorCode,
  concat,
  encodeNumber,
  encodeText,
} from '@neematajs-bun/common'
import type { Server } from 'bun'
import type { WsTransportSocket } from './types'

export const sendPayload = (
  ws: WsTransportSocket,
  type: number,
  payload: any,
) => {
  // TODO: https://github.com/oven-sh/bun/issues/9364
  // @ts-expect-error
  return send(ws, type, encodeText(toJSON(payload)!))
}

export const send = (
  ws: WsTransportSocket,
  type: number,
  ...buffers: ArrayBuffer[]
): boolean | null => {
  const result = ws.send(concat(encodeNumber(type, 'Uint8'), ...buffers), true)

  if (result === -1) {
    ws.data.backpressure = Promise.withResolvers()
    for (const stream of ws.data.streams.down.values()) stream.pause()
    return false
  } else if (result === 0) {
    return null
  } else {
    return true
  }
}

export const getRequest = (req: Request, server: Server) => {
  const base = 'http://unknown'
  const url = new URL(req.url, base)
  return {
    req,
    ip: server.requestIP(req),
    method: req.method,
    path: url.pathname,
    hash: url.hash,
    query: url.searchParams,
    queryString: url.search,
  }
}
export type ParsedRequest = ReturnType<typeof getRequest>

export const toJSON = (
  data: any,
  replacer?: (key: string, value: any) => any,
) => (data ? JSON.stringify(data, replacer) : undefined)

export const fromJSON = (
  data: any,
  replacer?: (key: string, value: any) => any,
) => (data ? JSON.parse(data, replacer) : undefined)

export const getBody = (req: Request) => {
  // biome-ignore lint/suspicious/noShadowRestrictedNames: is okay here
  const toString = () => req.text()
  const toStream = () => Readable.fromWeb(req.body!)
  const toBuffer = async () => Buffer.from(await req.arrayBuffer())
  const toJSON = async () => {
    const json = await toString()
    return json ? fromJSON(json) : undefined
  }
  return { toBuffer, toString, toJSON, toStream }
}

export const InternalError = (message = 'Internal Server Error') =>
  new ApiError(ErrorCode.InternalServerError, message)

export const NotFoundError = (message = 'Not Found') =>
  new ApiError(ErrorCode.NotFound, message)

export const ForbiddenError = (message = 'Forbidden') =>
  new ApiError(ErrorCode.Forbidden, message)

export const RequestTimeoutError = (message = 'Request Timeout') =>
  new ApiError(ErrorCode.RequestTimeout, message)
