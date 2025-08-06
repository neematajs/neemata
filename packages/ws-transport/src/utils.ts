import { ErrorCode } from '@nmtjs/protocol'
import { ProtocolError } from '@nmtjs/protocol/server'

export const InternalError = (message = 'Internal Server Error') =>
  new ProtocolError(ErrorCode.InternalServerError, message)

export const NotFoundError = (message = 'Not Found') =>
  new ProtocolError(ErrorCode.NotFound, message)

export const ForbiddenError = (message = 'Forbidden') =>
  new ProtocolError(ErrorCode.Forbidden, message)

export const RequestTimeoutError = (message = 'Request Timeout') =>
  new ProtocolError(ErrorCode.RequestTimeout, message)

export const NotFoundHttpResponse = () =>
  new Response('Not Found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain',
    },
  })

export const InternalServerErrorHttpResponse = () =>
  new Response('Internal Server Error', {
    status: 500,
    headers: {
      'Content-Type': 'text/plain',
    },
  })
