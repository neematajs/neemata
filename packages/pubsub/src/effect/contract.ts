import type { CodecSchemaCheck } from '@nmtjs/common'
import type { EffectSchema } from '@nmtjs/common/effect'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { codec } from '@nmtjs/common/effect'
import * as Schema from 'effect/Schema'

import type {
  Channel,
  ChannelParams,
  PayloadSchema,
  PayloadType,
} from '../contract.ts'
import { defineChannel as define } from '../contract.ts'

// Standard schemas are taken too, so an Effect application can reuse the
// schemas it already has from another library.
type EventSchema = EffectSchema | PayloadSchema

// Distributes, so a union of Effect and Standard schemas types as the union of
// their payloads.
type EventType<S> = S extends EffectSchema
  ? Schema.Schema.Type<S>
  : S extends PayloadSchema
    ? PayloadType<S>
    : never

type PayloadTypes<Events extends Record<string, EventSchema>> = {
  [K in keyof Events]: EventType<Events[K]>
}

// Every Effect schema becomes a { decode, encode } pair, so only Standard
// schemas can be a lone transform, and the core check passes the rest. The
// check stays unresolved for a type parameter, so the EffectSchema member
// admits events constrained to Effect schemas, as generic wrappers need.
type Checked<Events> = {
  [K in keyof Events]: Events[K] & (EffectSchema | CodecSchemaCheck<Events[K]>)
}

/**
 * Declares a channel with Effect or Standard schemas; the result is an
 * ordinary channel.
 */
export function defineChannel<
  const Name extends string,
  Events extends Record<string, EventSchema>,
>(options: {
  name: Name
  params?: undefined
  key?: undefined
  events: Events & Checked<Events>
}): Channel<undefined, PayloadTypes<Events>, Name>
export function defineChannel<
  const Name extends string,
  Params extends ChannelParams,
  Events extends Record<string, EventSchema>,
>(options: {
  name: Name
  params: Schema.Codec<Params, Params> | StandardSchemaV1<Params, Params>
  key: (params: Params) => string
  events: Events & Checked<Events>
}): Channel<Params, PayloadTypes<Events>, Name>
export function defineChannel(options: {
  name: string
  params?: EffectSchema | StandardSchemaV1
  key?: (params: any) => string
  events: Record<string, EventSchema>
}): Channel {
  const events: Record<string, PayloadSchema> = {}
  for (const event in options.events) {
    const schema = options.events[event]
    events[event] = Schema.isSchema(schema) ? codec(schema) : schema
  }
  const params = options.params
  return (define as (options: object) => Channel)({
    name: options.name,
    params: params && (Schema.isSchema(params) ? codec(params).decode : params),
    key: options.key,
    events,
  })
}
