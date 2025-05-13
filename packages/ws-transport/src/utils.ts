import type { HttpRequest, HttpResponse } from 'uWebSockets.js'
import { PassThrough, type Readable } from 'node:stream'
import { createPromise } from '@nmtjs/common'
import { concat, ErrorCode, encodeNumber } from '@nmtjs/protocol'
import { ProtocolError } from '@nmtjs/protocol/server'
import type { WsTransportSocket } from './types.ts'

export const send = (
  ws: WsTransportSocket,
  type: number,
  ...buffers: ArrayBuffer[]
): boolean | null => {
  const data = ws.getUserData()
  try {
    const buffer = concat(encodeNumber(type, 'Uint8'), ...buffers)
    const result = ws.send(buffer, true)
    if (result === 0) {
      data.backpressure = createPromise()
      return false
    }
    if (result === 2) {
      return null
    }
    return true
  } catch (error) {
    return null
  }
}

export const toRecord = (input: {
  forEach: (cb: (value, key) => void) => void
}) => {
  const obj: Record<string, string> = {}
  input.forEach((value, key) => {
    obj[key] = value
  })
  return obj
}

export type RequestData = Readonly<{
  url: string
  origin: URL | null
  method: string
  headers: Headers
  querystring: string
  query: URLSearchParams
  remoteAddress: string
  proxiedRemoteAddress: string
}>

export const getRequestData = (
  req: HttpRequest,
  res: HttpResponse,
): RequestData => {
  const url = req.getUrl()
  const method = req.getMethod()
  const headers = new Headers()
  const querystring = req.getQuery()
  const query = new URLSearchParams(querystring)
  const origin = headers.get('origin')
  const proxiedRemoteAddress = res.getProxiedRemoteAddressAsText()
  const remoteAddress = res.getRemoteAddressAsText()

  req.forEach((key, value) => headers.append(key, value))

  return Object.freeze({
    url,
    origin: origin ? new URL(url, origin) : null,
    method,
    headers,
    querystring,
    query,
    remoteAddress: Buffer.from(remoteAddress).toString(),
    proxiedRemoteAddress: Buffer.from(proxiedRemoteAddress).toString(),
  })
}

export function getRequestBody(res: HttpResponse) {
  const stream = new PassThrough()
  res.onData((chunk, isLast) => {
    stream.write(Buffer.from(chunk))
    if (isLast) stream.end()
  })
  res.onAborted(() => stream.destroy())
  return stream
}

export function setHeaders(res: HttpResponse, headers: Headers) {
  headers.forEach((value, key) => {
    if (key === 'set-cookie') return
    res.writeHeader(key, value)
  })
  const cookies = headers.getSetCookie()
  if (cookies) {
    for (const cookie of cookies) {
      res.writeHeader('set-cookie', cookie)
    }
  }
}

export function readableToArrayBuffer(stream: Readable): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk) => {
      chunks.push(chunk)
    })
    stream.on('end', () => {
      resolve(Buffer.concat(chunks).buffer)
    })
    stream.on('error', (error) => {
      reject(error)
    })
  })
}

export const InternalError = (message = 'Internal Server Error') =>
  new ProtocolError(ErrorCode.InternalServerError, message)

export const NotFoundError = (message = 'Not Found') =>
  new ProtocolError(ErrorCode.NotFound, message)

export const ForbiddenError = (message = 'Forbidden') =>
  new ProtocolError(ErrorCode.Forbidden, message)

export const RequestTimeoutError = (message = 'Request Timeout') =>
  new ProtocolError(ErrorCode.RequestTimeout, message)
