import type {
  CodecSchema,
  CodecSchemaCheck,
  CodecSchemaOutput,
  NotReversible,
  StandardCodec,
} from '@nmtjs/common'
import type { StandardSchemaV1 } from '@standard-schema/spec'

/** A payload whose published form differs from its application form. */
export type PubSubCodec<Type = any, Encoded = any> = StandardCodec<
  Type,
  Encoded
>

/** A single schema serves payloads that are published as they are. */
export type PayloadSchema = CodecSchema

export type PayloadType<T extends PayloadSchema> = CodecSchemaOutput<T>

export type NotPublishable<Input, Output> = NotReversible<Input, Output>

export type ChannelParams = Record<string, string | number | boolean | null>

declare const types: unique symbol

export interface ChannelEvent<
  Params = any,
  Payload = any,
  Event extends string = string,
> {
  readonly event: Event
  readonly payload: PayloadSchema
  readonly channel: Channel<Params, any>
  readonly [types]?: { readonly params: Params; readonly payload: Payload }
}

/** `Events` maps each event name to its payload type. */
export interface Channel<
  Params = any,
  Events extends Record<string, unknown> = Record<string, unknown>,
  Name extends string = string,
> {
  readonly name: Name
  readonly params?: StandardSchemaV1<any, Params>
  readonly key?: (params: Params) => string
  readonly events: {
    readonly [K in keyof Events]: ChannelEvent<
      Params,
      Events[K],
      Extract<K, string>
    >
  }
}

export type EventParams<E extends ChannelEvent> =
  E extends ChannelEvent<infer Params, any> ? Params : never

export type EventPayload<E extends ChannelEvent> =
  E extends ChannelEvent<any, infer Payload> ? Payload : never

export type EventMessage<Events, K extends keyof Events> = {
  readonly event: Extract<K, string>
  readonly payload: Events[K]
}

export type SelectedEventUnion<
  C extends Channel,
  Selected extends Partial<Record<keyof C['events'], true>>,
> =
  C extends Channel<any, infer Events>
    ? {} extends Selected
      ? { [K in keyof Events]: EventMessage<Events, K> }[keyof Events]
      : {
          [K in keyof Selected]: K extends keyof Events
            ? EventMessage<Events, K>
            : never
        }[keyof Selected]
    : never

type PayloadTypes<Events extends Record<string, PayloadSchema>> = {
  [K in keyof Events]: PayloadType<Events[K]>
}

type Checked<Events> = {
  [K in keyof Events]: Events[K] & CodecSchemaCheck<Events[K]>
}

export function defineChannel<
  const Name extends string,
  Events extends Record<string, PayloadSchema>,
>(options: {
  name: Name
  params?: undefined
  key?: undefined
  events: Events & Checked<Events>
}): Channel<undefined, PayloadTypes<Events>, Name>
export function defineChannel<
  const Name extends string,
  Params extends ChannelParams,
  Events extends Record<string, PayloadSchema>,
>(options: {
  name: Name
  params: StandardSchemaV1<Params, Params>
  key: (params: Params) => string
  events: Events & Checked<Events>
}): Channel<Params, PayloadTypes<Events>, Name>
export function defineChannel(options: {
  name: string
  params?: StandardSchemaV1
  key?: (params: any) => string
  events: Record<string, PayloadSchema>
}): Channel {
  const events: Record<string, ChannelEvent> = {}
  const channel: Channel = {
    name: options.name,
    params: options.params,
    key: options.key,
    events,
  }
  for (const event in options.events)
    events[event] = { event, payload: options.events[event], channel }
  return channel
}
