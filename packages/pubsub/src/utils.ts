import type {
  SubscriptionParams,
  TAnySubscriptionContract,
} from '@nmtjs/contract'

export function resolvePubSubChannelName(
  channel: TAnySubscriptionContract,
  params: SubscriptionParams<TAnySubscriptionContract>,
): string {
  return channel.channel(channel.params.decode(params))
}
