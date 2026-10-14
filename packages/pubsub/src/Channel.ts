import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

const SEPARATOR = ':'

/** The values that key a channel. */
export type Params = Record<string, string | number | boolean | null>

/**
 * Payloads are published through their JSON encoding and may decode
 * asynchronously, but cannot require services.
 */
export type PayloadSchema<Type = any> = Schema.Codec<Type, unknown>

export interface Event<P = any, Payload = any, Name extends string = string> {
  readonly event: Name
  readonly payload: PayloadSchema<Payload>
  readonly channel: Channel<P, any>
  /**
   * The payload's JSON encoding. Untyped, so an event stays assignable to one
   * of a wider payload; `PubSub` checks the payload it is given.
   *
   * @internal
   */
  readonly encode: (
    payload: unknown,
  ) => Effect.Effect<Schema.Json, Schema.SchemaError>
  /** @internal */
  readonly decode: (
    encoded: unknown,
  ) => Effect.Effect<Payload, Schema.SchemaError>
}

/** `Events` maps each event name to its payload type. */
export interface Channel<
  P = any,
  Events extends Record<string, unknown> = Record<string, unknown>,
  Name extends string = string,
> {
  readonly name: Name
  readonly params?: Schema.Codec<P, P>
  readonly key?: (params: P) => string
  readonly events: {
    readonly [K in keyof Events]: Event<P, Events[K], Extract<K, string>>
  }
  /**
   * The broker channel `params` selects. Fails if they do not satisfy the
   * channel's `params` schema.
   *
   * @internal
   */
  readonly resolve: (
    params: unknown,
  ) => Effect.Effect<string, Schema.SchemaError>
}

export type ParamsOf<C extends Channel> =
  C extends Channel<infer P, any> ? P : never

export declare namespace Event {
  export type Params<E extends Event> =
    E extends Event<infer P, any> ? P : never

  export type Payload<E extends Event> =
    E extends Event<any, infer Payload> ? Payload : never
}

export type Selection<C extends Channel> = Partial<
  Record<keyof C['events'], true>
>

type MessageOf<Events, K extends keyof Events> = {
  readonly event: Extract<K, string>
  readonly payload: Events[K]
}

type AnyMessageOf<Events> = {
  [K in keyof Events]: MessageOf<Events, K>
}[keyof Events]

/** What a subscription to `Selected` events of `C` delivers; all, if none. */
export type Message<
  C extends Channel,
  Selected extends Selection<C> | undefined = undefined,
> =
  C extends Channel<any, infer Events>
    ? // Distributes, so a union of selections delivers any of their events.
      Selected extends unknown
      ? Selected extends undefined
        ? AnyMessageOf<Events>
        : {} extends Selected
          ? AnyMessageOf<Events>
          : {
              [K in keyof Selected]-?: K extends keyof Events
                ? MessageOf<Events, K>
                : never
            }[keyof Selected]
      : never
    : never

type PayloadTypes<Events extends Record<string, PayloadSchema>> = {
  [K in keyof Events]: Schema.Schema.Type<Events[K]>
}

// Definitions are shared with code that never publishes or subscribes, so the
// JSON codec and its parsers are derived on first use.
function lazy<A>(make: () => A): () => A {
  let made: A | undefined
  return () => (made ??= make())
}

const isJson = Schema.is(Schema.Json)
// Fails with a `SchemaError` for a value that is not JSON.
const asJson = Schema.decodeUnknownEffect(Schema.Json)

function makeEvent(
  event: string,
  payload: PayloadSchema,
  channel: Channel,
): Event {
  const json = lazy(() => Schema.toCodecJson(payload))
  const encode = lazy(() => Schema.encodeUnknownEffect(json()))
  const decode = lazy(() => Schema.decodeUnknownEffect(json()))
  return {
    event,
    payload,
    channel,
    encode: (value) =>
      Effect.flatMap(encode()(value), (encoded) =>
        // The JSON codec passes `Schema.Any` through as it is, and a value
        // JSON would alter could never be decoded by a subscriber. An absent
        // payload stays absent, as JSON omits it.
        encoded === undefined || isJson(encoded)
          ? Effect.succeed(encoded)
          : asJson(encoded),
      ),
    decode: (encoded) => decode()(encoded),
  }
}

function makeResolve(
  name: string,
  params: Schema.Codec<any, any> | undefined,
  key: ((params: any) => string) | undefined,
): Channel['resolve'] {
  // An unkeyed channel is a single broker channel, whatever it is given.
  if (!params || !key) return () => Effect.succeed(name)

  const validate = Schema.decodeUnknownEffect(params)
  return (value) =>
    Effect.map(validate(value), (valid) => {
      const suffix = encodeURIComponent(key(valid))
      return `${name}${SEPARATOR}${suffix}`
    })
}

/**
 * Declares a channel: the events it carries and, optionally, the params that
 * key it into separate broker channels.
 */
export function make<
  const Name extends string,
  Events extends Record<string, PayloadSchema>,
>(
  name: Name,
  options: {
    readonly params?: undefined
    readonly key?: undefined
    readonly events: Events
  },
): Channel<undefined, PayloadTypes<Events>, Name>
export function make<
  const Name extends string,
  P extends Params,
  Events extends Record<string, PayloadSchema>,
>(
  name: Name,
  options: {
    readonly params: Schema.Codec<P, P>
    readonly key: (params: P) => string
    readonly events: Events
  },
): Channel<P, PayloadTypes<Events>, Name>
export function make(
  name: string,
  options: {
    readonly params?: Schema.Codec<any, any>
    readonly key?: (params: any) => string
    readonly events: Record<string, PayloadSchema>
  },
): Channel {
  const { params, key } = options
  // No prototype, so that an event may have any name, `__proto__` included.
  const events: Record<string, Event> = Object.create(null)
  const resolve = makeResolve(name, params, key)
  const channel: Channel = { name, params, key, events, resolve }
  for (const event in options.events)
    events[event] = makeEvent(event, options.events[event], channel)
  return channel
}
