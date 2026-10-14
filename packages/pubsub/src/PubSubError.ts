import * as Schema from 'effect/Schema'

/**
 * Ends a live subscription whose broker connection closed. Messages published
 * until the channel is subscribed again are lost, so a subscriber resubscribes
 * and refetches whatever state it derives from them.
 */
export class PubSubConnectionLostError extends Schema.TaggedError<PubSubConnectionLostError>()(
  'PubSubConnectionLostError',
  {},
) {}

/**
 * A publish or a subscription failed, or its outcome is unknown: a command
 * that timed out may still reach the broker, so a failed publish may have been
 * delivered.
 */
export class PubSubError extends Schema.TaggedError<PubSubError>()(
  'PubSubError',
  { cause: Schema.Defect() },
) {}
