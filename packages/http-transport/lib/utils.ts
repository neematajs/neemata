import { Readable } from 'node:stream'
import type { Format } from '@neematajs/application'
import { ApiError, ErrorCode } from '@neematajs/common'
import { JsonFormat } from '@neematajs/json-format/server'
import type { Server } from 'bun'

export type ParsedRequest = ReturnType<typeof getRequest>

export const defaultFormat = new JsonFormat()

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

export const getBody = (req: Request) => {
  const asString = () => req.text()
  const asStream = () => Readable.fromWeb(req.body!)
  const asArrayBuffer = () => req.arrayBuffer()
  const asBuffer = () => asArrayBuffer().then(Buffer.from)
  return { asBuffer, asArrayBuffer, asString, asStream }
}

export const InternalError = (message = 'Internal Server Error') =>
  new ApiError(ErrorCode.InternalServerError, message)

export const NotFoundError = (message = 'Not Found') =>
  new ApiError(ErrorCode.NotFound, message)

export const ForbiddenError = (message = 'Forbidden') =>
  new ApiError(ErrorCode.Forbidden, message)

export const RequestTimeoutError = (message = 'Request Timeout') =>
  new ApiError(ErrorCode.RequestTimeout, message)

export const getFormat = (req: Request, format: Format) => {
  const contentType = req.headers.get('content-type')
  const acceptType = req.headers.get('accept')

  const encoder = contentType ? format.supports(contentType) : defaultFormat
  if (!encoder) throw new Error('Unsupported content-type')

  const decoder = acceptType ? format.supports(acceptType) : defaultFormat
  if (!decoder) throw new Error('Unsupported accept')

  return {
    encoder,
    decoder,
  }
}
