export const kCommand: unique symbol = Symbol.for('neemata:CommandKey')
export type kCommand = typeof kCommand

export const kConnectionNotify: unique symbol = Symbol.for(
  'neemata:ConnectionTransportKey',
)
export type kConnectionNotify = typeof kConnectionNotify

export const kJobKey: unique symbol = Symbol('neemat:JobKey')
export type kJobKey = typeof kJobKey

export const kApplicationConfig: unique symbol = Symbol.for(
  'neemata:ApplicationConfig',
)
export type kApplicationConfig = typeof kApplicationConfig
