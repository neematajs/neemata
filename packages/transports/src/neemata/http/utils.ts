// Runtime hosts and handlers must share these exact response/error identities.
export {
  internalServerErrorResponse,
  notFoundResponse,
  okResponse,
  PayloadTooLargeError,
} from '../../http-server/utils.ts'
