import { SchemaError, validateSync } from '@nmtjs/common'

import type { Channel } from './contract.ts'

const PUBSUB_CHANNEL_SEPARATOR = ':'

type LogFn = (obj: unknown, msg?: string) => void

/** The subset of a Pino logger this package writes to. */
export type PubSubLogger = {
  readonly trace: LogFn
  readonly debug: LogFn
  readonly warn: LogFn
  readonly error: LogFn
}

export function resolvePubSubChannel(
  channel: Channel,
  params: unknown,
): string {
  if (!channel.params || !channel.key) return channel.name
  const key = channel.key(validateSync(channel.params, params) as never)
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

/**
 * Ends a live subscription whose broker connection closed. Messages published
 * until the channel is subscribed again are lost, so a subscriber resubscribes
 * and refetches whatever state it derives from them.
 */
export class PubSubConnectionLostError extends Error {
  constructor(options?: ErrorOptions) {
    super('PubSub connection lost', options)
    this.name = 'PubSubConnectionLostError'
  }
}

/** The issues a schema reported for channel params or an event payload. */
export { SchemaError as PubSubSchemaError }
