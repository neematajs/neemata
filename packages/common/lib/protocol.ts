export const MessageType = Object.freeze({
  // Common
  Event: 10,
  Rpc: 11,
  RpcBatch: 12,
  RpcStream: 13,
  RpcAbort: 14,
  Subscription: 15,

  // Client streams
  ClientStreamAbort: 30,
  ClientStreamPush: 31,
  ClientStreamPull: 32,
  ClientStreamEnd: 33,

  // Client subsctiption
  ClientUnsubscribe: 34,

  // Server streams
  ServerStreamAbort: 50,
  ServerStreamPull: 51,
  ServerStreamPush: 52,
  ServerStreamEnd: 53,

  // Server subsctiption
  ServerUnsubscribe: 54,
  ServerSubscriptionEvent: 55,
})
export type MessageType = (typeof MessageType)[keyof typeof MessageType]

export enum TransportType {
  WS = 'WS',
  HTTP = 'HTTP',
}
