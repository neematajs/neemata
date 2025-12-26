export const kServerConfig: unique symbol = Symbol.for(
  'neemata:ServerConfigKey',
)
export type kServerConfig = typeof kServerConfig

export const kCommand: unique symbol = Symbol.for('neemata:CommandKey')
export type kCommand = typeof kCommand

export const kJobKey: unique symbol = Symbol.for('neemata:JobKey')
export type kJobKey = typeof kJobKey

export const kJobStepKey: unique symbol = Symbol.for('neemata:JobStepKey')
export type kJobStepKey = typeof kJobStepKey
