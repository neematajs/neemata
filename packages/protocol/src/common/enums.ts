export enum ClientMessageType {
  Rpc = 10,
  RpcAbort = 11,
  RpcStreamAbort = 12,

  ClientStreamPush = 20,
  ClientStreamEnd = 21,
  ClientStreamAbort = 22,
  ServerStreamAbort = 23,
  ServerStreamPull = 24,
}

export enum ServerMessageType {
  Event = 1,

  RpcResponse = 10,
  RpcStreamResponse = 11,
  RpcStreamChunk = 12,
  RpcStreamAbort = 13,

  ServerStreamPush = 20,
  ServerStreamEnd = 21,
  ServerStreamAbort = 22,
  ClientStreamAbort = 23,
  ClientStreamPull = 24,
}

export enum TransportType {
  Bidirectional = 'Bidirectional',
  Unidirectional = 'Unidirectional',
}

export enum ErrorCode {
  ValidationError = 'ValidationError',
  BadRequest = 'BadRequest',
  NotFound = 'NotFound',
  Forbidden = 'Forbidden',
  Unauthorized = 'Unauthorized',
  InternalServerError = 'InternalServerError',
  NotAcceptable = 'NotAcceptable',
  RequestTimeout = 'RequestTimeout',
  GatewayTimeout = 'GatewayTimeout',
  ServiceUnavailable = 'ServiceUnavailable',
  ClientRequestError = 'ClientRequestError',
  ConnectionError = 'ConnectionError',
}
