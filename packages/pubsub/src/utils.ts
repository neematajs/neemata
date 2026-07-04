import type {
  SubscriptionParams,
  TAnySubscriptionContract,
} from '@nmtjs/contract'

const PUBSUB_CHANNEL_SEPARATOR = ':'

export function resolvePubSubChannel<Channel extends TAnySubscriptionContract>(
  channel: Channel,
  params: SubscriptionParams<Channel>,
): string {
  const key = channel.key?.(channel.params.decode(params))
  return key === undefined
    ? channel.namespace
    : `${channel.namespace}${PUBSUB_CHANNEL_SEPARATOR}${encodeURIComponent(key)}`
}
