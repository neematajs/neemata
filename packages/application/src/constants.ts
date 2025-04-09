export const kProcedure: unique symbol = Symbol.for('neemata:ProcedureKey')
export type kProcedure = typeof kProcedure

export const kSubscription: unique symbol = Symbol.for(
  'neemata:SubscriptionKey',
)
export type kSubscription = typeof kSubscription

export const kProcedureMetadata: unique symbol = Symbol.for(
  'neemata:ProcedureMetadataKey',
)
export type kProcedureMetadata = typeof kProcedureMetadata

export const kNamespace: unique symbol = Symbol.for('neemata:NamespaceKey')
export type kNamespace = typeof kNamespace

export const kTask: unique symbol = Symbol.for('neemata:TaskKey')
export type kTask = typeof kTask

export const kIterableResponse: unique symbol = Symbol.for(
  'neemata:IterableResponseKey',
)
export type kIterableResponse = typeof kIterableResponse

export const kConnectionNotify: unique symbol = Symbol.for(
  'neemata:ConnectionTransportKey',
)
export type kConnectionNotify = typeof kConnectionNotify
