export const kProcedure: unique symbol = Symbol.for('neemata:ProcedureKey')
export type kProcedure = typeof kProcedure

export const kRouter: unique symbol = Symbol.for('neemata:RouterKey')
export type kRouter = typeof kRouter

export const kTask: unique symbol = Symbol.for('neemata:TaskKey')
export type kTask = typeof kTask

export const kConnectionNotify: unique symbol = Symbol.for(
  'neemata:ConnectionTransportKey',
)
export type kConnectionNotify = typeof kConnectionNotify
