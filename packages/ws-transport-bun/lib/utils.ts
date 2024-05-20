import type { Format } from '@neematajs/application'
import {
  ApiError,
  type BaseServerFormat,
  ErrorCode,
  concat,
  encodeNumber,
} from '@neematajs/common'
import { MessagepackFormat } from '@neematajs/messagepack-format/server'
import type { WsTransportSocket } from './types'

const defaultFormat = new MessagepackFormat()

export const sendPayload = (
  ws: WsTransportSocket,
  type: number,
  payload: any,
) => {
  return send(ws, type, ws.data.format.encoder.decode(payload))
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

export const getFormat = (req: Request, format: Format) => {
  const contentType =
    req.headers.get('content-type') ||
    new URL(req.url, 'http://localhost').searchParams.get('content-type')

  const acceptType =
    req.headers.get('accept') ||
    new URL(req.url, 'http://localhost').searchParams.get('accept')

  const encoder = contentType ? format.supports(contentType) : defaultFormat
  if (!encoder) throw new Error('Unsupported content-type')

  const decoder = acceptType ? format.supports(acceptType) : defaultFormat
  if (!decoder) throw new Error('Unsupported accept')

  return {
    encoder,
    decoder,
  }
}

export const InternalError = (message = 'Internal Server Error') =>
  new ApiError(ErrorCode.InternalServerError, message)

export const NotFoundError = (message = 'Not Found') =>
  new ApiError(ErrorCode.NotFound, message)

export const ForbiddenError = (message = 'Forbidden') =>
  new ApiError(ErrorCode.Forbidden, message)

export const RequestTimeoutError = (message = 'Request Timeout') =>
  new ApiError(ErrorCode.RequestTimeout, message)