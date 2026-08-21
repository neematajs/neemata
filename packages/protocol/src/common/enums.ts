export enum ProtocolVersion {
  v1 = 1,
}

export enum ClientMessageType {
  Rpc = 10,
  RpcAbort = 11,
  RpcStreamPull = 12,

  Ping = 13,
  Pong = 14,

  ClientBlobPush = 20,
  ClientBlobEnd = 21,
  ClientBlobAbort = 22,

  ServerBlobAbort = 33,
  ServerBlobPull = 34,
}

export enum ServerMessageType {
  RpcResponse = 10,
  RpcStreamResponse = 11,
  RpcStreamChunk = 12,
  RpcStreamEnd = 13,
  RpcStreamAbort = 14,

  Pong = 15,
  Ping = 16,

  ServerBlobPush = 20,
  ServerBlobEnd = 21,
  ServerBlobAbort = 22,

  ClientBlobAbort = 33,
  ClientBlobPull = 34,
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

export const MessageByteLength = {
  MessageType: 1,
  MessageError: 1,
  ProcedureLength: 2,
  CallId: 4,
  StreamId: 4,
  ChunkSize: 4,
} as const
