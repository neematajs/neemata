export const kTask: unique symbol = Symbol.for('neemata:TaskKey')
export type kTask = typeof kTask

export const kConnectionNotify: unique symbol = Symbol.for(
  'neemata:ConnectionTransportKey',
)
export type kConnectionNotify = typeof kConnectionNotify
