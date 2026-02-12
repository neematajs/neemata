export enum ProtocolVersion {
  v1 = 1,
}

export enum ClientMessageType {
  Rpc = 10,
  RpcAbort = 11,
  RpcPull = 12,

  Ping = 13,
  Pong = 14,

  ClientStreamPush = 20,
  ClientStreamEnd = 21,
  ClientStreamAbort = 22,

  ServerStreamAbort = 33,
  ServerStreamPull = 34,
}

export enum ServerMessageType {
  // Event = 1,

  RpcResponse = 10,
  RpcStreamResponse = 11,
  RpcStreamChunk = 12,
  RpcStreamEnd = 13,
  RpcStreamAbort = 14,

  Pong = 15,
  Ping = 16,

  ServerStreamPush = 20,
  ServerStreamEnd = 21,
  ServerStreamAbort = 22,

  ClientStreamAbort = 33,
  ClientStreamPull = 34,
}

export enum ConnectionType {
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

export enum MessageByteLength {
  MessageType = 1,
  MessageError = 1,
  ProcedureLength = 2,
  CallId = 4,
  StreamId = 4,
  ChunkSize = 4,
}
