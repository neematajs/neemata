export const MessageType = Object.freeze({
  // Common
  Event: 10,
  Rpc: 11,
  RpcBatch: 12,
  RpcAbort: 14,
  RpcSubscription: 15,

  // Client streams
  UpStreamAbort: 30,
  UpStreamPush: 31,
  UpStreamPull: 32,
  UpStreamEnd: 33,

  // Client subsctiption
  ClientUnsubscribe: 34,

  // Server streams
  DownStreamAbort: 50,
  DownStreamPull: 51,
  DownStreamPush: 52,
  DownStreamEnd: 53,

  // Server subsctiption
  ServerUnsubscribe: 54,
  ServerSubscriptionEvent: 55,
} as const)

export type MessageType = (typeof MessageType)[keyof typeof MessageType]

export const MessageTypeName = Object.fromEntries(
  Object.entries(MessageType).map(([k, v]) => [v, k]),
)
export type MessageTypeName = keyof typeof MessageType

// TODO: Should it be hardcoded ??
export enum TransportType {
  WS = 'WS',
  HTTP = 'HTTP',
}
