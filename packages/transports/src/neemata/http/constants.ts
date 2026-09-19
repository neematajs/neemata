import type { MetadataKind } from '@nmtjs/application'
import { createMeta } from '@nmtjs/application'
import { ErrorCode } from '@nmtjs/protocol'

// Single source in the host: every runtime enforces the same default bound.
export { DEFAULT_MAX_REQUEST_BODY_SIZE } from '../../http-server/host.ts'

/**
 * Only the statuses this handler can produce. Each one needs a reason phrase
 * below, because HTTP/1 responses carry the status text the handler sets.
 */
export enum HttpStatus {
  OK = 200,
  BadRequest = 400,
  Unauthorized = 401,
  Forbidden = 403,
  NotFound = 404,
  NotAcceptable = 406,
  RequestTimeout = 408,
  PayloadTooLarge = 413,
  UnsupportedMediaType = 415,
  InternalServerError = 500,
  ServiceUnavailable = 503,
  GatewayTimeout = 504,
}

export const HttpStatusText: Record<HttpStatus, string> = {
  [HttpStatus.OK]: 'OK',
  [HttpStatus.BadRequest]: 'Bad Request',
  [HttpStatus.Unauthorized]: 'Unauthorized',
  [HttpStatus.Forbidden]: 'Forbidden',
  [HttpStatus.NotFound]: 'Not Found',
  [HttpStatus.NotAcceptable]: 'Not Acceptable',
  [HttpStatus.RequestTimeout]: 'Request Timeout',
  [HttpStatus.PayloadTooLarge]: 'Payload Too Large',
  [HttpStatus.UnsupportedMediaType]: 'Unsupported Media Type',
  [HttpStatus.InternalServerError]: 'Internal Server Error',
  [HttpStatus.ServiceUnavailable]: 'Service Unavailable',
  [HttpStatus.GatewayTimeout]: 'Gateway Timeout',
}

export const ProtocolToHttpStatus: Partial<Record<ErrorCode, HttpStatus>> = {
  [ErrorCode.ValidationError]: HttpStatus.BadRequest,
  [ErrorCode.BadRequest]: HttpStatus.BadRequest,
  [ErrorCode.NotFound]: HttpStatus.NotFound,
  [ErrorCode.Forbidden]: HttpStatus.Forbidden,
  [ErrorCode.Unauthorized]: HttpStatus.Unauthorized,
  [ErrorCode.InternalServerError]: HttpStatus.InternalServerError,
  [ErrorCode.NotAcceptable]: HttpStatus.NotAcceptable,
  [ErrorCode.RequestTimeout]: HttpStatus.RequestTimeout,
  [ErrorCode.GatewayTimeout]: HttpStatus.GatewayTimeout,
  [ErrorCode.ServiceUnavailable]: HttpStatus.ServiceUnavailable,
  [ErrorCode.ClientRequestError]: HttpStatus.BadRequest,
  [ErrorCode.ConnectionError]: HttpStatus.NotAcceptable,
}

export const AllowedHttpMethod = createMeta<
  Array<'get' | 'post' | 'put' | 'delete' | 'patch'>,
  MetadataKind.STATIC
>()
