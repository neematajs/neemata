import type {
  SubscriptionParams,
  TAnySubscriptionContract,
} from '@nmtjs/contract'
import { validateSchema } from '@nmtjs/common/schema'

const PUBSUB_CHANNEL_SEPARATOR = ':'

export async function resolvePubSubChannel<
  Channel extends TAnySubscriptionContract,
>(channel: Channel, params: SubscriptionParams<Channel>): Promise<string> {
  const validatedParams = channel.params
    ? await validateSchema(channel.params, params)
    : undefined
  const key = channel.key?.(validatedParams as never)
  return key === undefined
    ? channel.namespace
    : `${channel.namespace}${PUBSUB_CHANNEL_SEPARATOR}${encodeURIComponent(key)}`
}
