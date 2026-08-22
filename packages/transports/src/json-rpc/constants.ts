import { ErrorCode } from '@nmtjs/protocol'

export const DEFAULT_MAX_BATCH_SIZE = 100
// Bounded parallelism inside a batch: the spec permits any execution order,
// but unbounded Promise.all would let one request occupy every call scope
export const BATCH_CONCURRENCY = 10

export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // Implementation-defined server errors (-32000..-32099)
  Unauthorized: -32001,
  Forbidden: -32002,
  NotAcceptable: -32003,
  RequestTimeout: -32004,
  GatewayTimeout: -32005,
  ServiceUnavailable: -32006,
  ClientRequestError: -32007,
  ConnectionError: -32008,
} as const

export const ProtocolToJsonRpcCode: Record<string, number> = {
  [ErrorCode.ValidationError]: JsonRpcErrorCode.InvalidParams,
  [ErrorCode.BadRequest]: JsonRpcErrorCode.InvalidRequest,
  [ErrorCode.NotFound]: JsonRpcErrorCode.MethodNotFound,
  [ErrorCode.InternalServerError]: JsonRpcErrorCode.InternalError,
  [ErrorCode.Unauthorized]: JsonRpcErrorCode.Unauthorized,
  [ErrorCode.Forbidden]: JsonRpcErrorCode.Forbidden,
  [ErrorCode.NotAcceptable]: JsonRpcErrorCode.NotAcceptable,
  [ErrorCode.RequestTimeout]: JsonRpcErrorCode.RequestTimeout,
  [ErrorCode.GatewayTimeout]: JsonRpcErrorCode.GatewayTimeout,
  [ErrorCode.ServiceUnavailable]: JsonRpcErrorCode.ServiceUnavailable,
  [ErrorCode.ClientRequestError]: JsonRpcErrorCode.ClientRequestError,
  [ErrorCode.ConnectionError]: JsonRpcErrorCode.ConnectionError,
}

// JSON-RPC method segments mirror native route keys (which are restricted to
// [a-zA-Z0-9-]) joined with "." — the transform back to "/" is bijective
export const JSON_RPC_METHOD_PATTERN = /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*$/

// Selection patterns operate on native names: exact ("users/create"),
// subtree ("users/*") or everything ("*")
export const SELECTION_PATTERN = /^(\*|[a-zA-Z0-9-]+(\/[a-zA-Z0-9-]+)*(\/\*)?)$/
