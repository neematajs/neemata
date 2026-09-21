import type * as Schema from 'effect/Schema'

import type { Channel, ChannelParams, PubSubCodec } from '../contract.ts'
import type { EffectSchema } from './codec.ts'
import { defineChannel as define } from '../contract.ts'
import { codec } from './codec.ts'

type PayloadTypes<Events extends Record<string, EffectSchema>> = {
  [K in keyof Events]: Schema.Schema.Type<Events[K]>
}

/** Declares a channel with Effect schemas; the result is an ordinary channel. */
export function defineChannel<
  const Name extends string,
  Events extends Record<string, EffectSchema>,
>(options: {
  name: Name
  params?: undefined
  key?: undefined
  events: Events
}): Channel<undefined, PayloadTypes<Events>, Name>
export function defineChannel<
  const Name extends string,
  Params extends ChannelParams,
  Events extends Record<string, EffectSchema>,
>(options: {
  name: Name
  params: Schema.Codec<Params, Params>
  key: (params: Params) => string
  events: Events
}): Channel<Params, PayloadTypes<Events>, Name>
export function defineChannel(options: {
  name: string
  params?: EffectSchema
  key?: (params: any) => string
  events: Record<string, EffectSchema>
}): Channel {
  const events: Record<string, PubSubCodec> = {}
  for (const event in options.events)
    events[event] = codec(options.events[event])
  return (define as (options: object) => Channel)({
    name: options.name,
    params: options.params && codec(options.params).decode,
    key: options.key,
    events,
  })
}
