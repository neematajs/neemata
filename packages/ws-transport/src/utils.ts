import type { HttpRequest } from 'uWebSockets.js'
import { createPromise } from '@nmtjs/common'
import { concat, ErrorCode, encodeNumber } from '@nmtjs/protocol/common'
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

type RequestData = {
  url: string
  origin: URL | null
  method: string
  headers: Map<string, string>
  query: URLSearchParams
}

export const getRequestData = (req: HttpRequest): RequestData => {
  const url = req.getUrl()
  const method = req.getMethod()
  const headers = new Map()
  req.forEach((key, value) => headers.set(key, value))
  const query = new URLSearchParams(req.getQuery())
  const origin = headers.has('origin')
    ? new URL(url, headers.get('origin'))
    : null

  return {
    url,
    origin,
    method,
    headers,
    query,
  }
}

export const InternalError = (message = 'Internal Server Error') =>
  new ProtocolError(ErrorCode.InternalServerError, message)

export const NotFoundError = (message = 'Not Found') =>
  new ProtocolError(ErrorCode.NotFound, message)

export const ForbiddenError = (message = 'Forbidden') =>
  new ProtocolError(ErrorCode.Forbidden, message)

export const RequestTimeoutError = (message = 'Request Timeout') =>
  new ProtocolError(ErrorCode.RequestTimeout, message)
