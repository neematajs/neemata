export const kProcedure: unique symbol = Symbol.for('neemata:ProcedureKey')
export type kProcedure = typeof kProcedure

export const kNamespace: unique symbol = Symbol.for('neemata:NamespaceKey')
export type kNamespace = typeof kNamespace

export const kTask: unique symbol = Symbol.for('neemata:TaskKey')
export type kTask = typeof kTask

export const kConnectionNotify: unique symbol = Symbol.for(
  'neemata:ConnectionTransportKey',
)
export type kConnectionNotify = typeof kConnectionNotify
