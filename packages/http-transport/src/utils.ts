import { ErrorCode } from '@nmtjs/protocol'
import { ProtocolError } from '@nmtjs/protocol/server'

// Response helpers and PayloadTooLargeError live in @nmtjs/server-host: the
// runtime hosts throw/build them, and instanceof matching in this package
// requires the same class identity
export {
  InternalServerErrorHttpResponse,
  NotFoundHttpResponse,
  OkResponse,
  PayloadTooLargeError,
} from '@nmtjs/server-host'

export const InternalError = (message = 'Internal Server Error') =>
  new ProtocolError(ErrorCode.InternalServerError, message)

export const NotFoundError = (message = 'Not Found') =>
  new ProtocolError(ErrorCode.NotFound, message)

export const ForbiddenError = (message = 'Forbidden') =>
  new ProtocolError(ErrorCode.Forbidden, message)

export const RequestTimeoutError = (message = 'Request Timeout') =>
  new ProtocolError(ErrorCode.RequestTimeout, message)
