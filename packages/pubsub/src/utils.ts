import type { StandardSchemaV1 } from '@standard-schema/spec'

import type { Channel, PayloadSchema } from './contract.ts'

const PUBSUB_CHANNEL_SEPARATOR = ':'

type LogFn = (obj: unknown, msg?: string) => void

/** The subset of a Pino logger this package writes to. */
export type PubSubLogger = {
  readonly trace: LogFn
  readonly debug: LogFn
  readonly warn: LogFn
  readonly error: LogFn
}

/** The issues a schema reported for channel params or an event payload. */
export class PubSubSchemaError extends Error {
  constructor(readonly issues: readonly StandardSchemaV1.Issue[]) {
    super(issues.map((issue) => issue.message).join('; '))
    this.name = 'PubSubSchemaError'
  }
}

function validate(schema: StandardSchemaV1, value: unknown): unknown {
  const result = schema['~standard'].validate(value)
  // Decoding happens inside the subscription pump, between adapter pulls.
  if (result instanceof Promise)
    throw new TypeError('PubSub schemas must validate synchronously')
  if (result.issues) throw new PubSubSchemaError(result.issues)
  return result.value
}

export function encodePayload(schema: PayloadSchema, value: unknown) {
  return validate('~standard' in schema ? schema : schema.encode, value)
}

export function decodePayload(schema: PayloadSchema, value: unknown) {
  return validate('~standard' in schema ? schema : schema.decode, value)
}

export function resolvePubSubChannel(
  channel: Channel,
  params: unknown,
): string {
  if (!channel.params || !channel.key) return channel.name
  const key = channel.key(validate(channel.params, params))
  return `${channel.name}${PUBSUB_CHANNEL_SEPARATOR}${encodeURIComponent(key)}`
}

export function isAbortError(error: any): error is Error {
  return (
    (error instanceof Error &&
      error.name === 'AbortError' &&
      'code' in error &&
      (error.code === 20 || error.code === 'ABORT_ERR')) ||
    (error instanceof globalThis.Event && error.type === 'abort')
  )
}
