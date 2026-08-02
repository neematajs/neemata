import { ErrorCode } from '@nmtjs/protocol'
import { ProtocolError } from '@nmtjs/protocol/server'

// Response helpers live in @nmtjs/server-host, shared by every runtime host
export {
  InternalServerErrorHttpResponse,
  NotFoundHttpResponse,
  OkResponse as StatusResponse,
} from '@nmtjs/server-host'

export const InternalError = (message = 'Internal Server Error') =>
  new ProtocolError(ErrorCode.InternalServerError, message)

export const NotFoundError = (message = 'Not Found') =>
  new ProtocolError(ErrorCode.NotFound, message)

export const ForbiddenError = (message = 'Forbidden') =>
  new ProtocolError(ErrorCode.Forbidden, message)

export const RequestTimeoutError = (message = 'Request Timeout') =>
  new ProtocolError(ErrorCode.RequestTimeout, message)
