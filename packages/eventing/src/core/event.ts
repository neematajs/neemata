import type { BaseType, t } from '@nmtjs/type'

export type EventingHeaders = Record<string, string>

export type AnyEventingEvent = EventingEvent<
  string,
  string,
  BaseType,
  BaseType | undefined
>

export type EventingEvent<
  Name extends string = string,
  Topic extends string = string,
  Payload extends BaseType = BaseType,
  Key extends BaseType | undefined = undefined,
> = {
  readonly type: 'nmtjs:eventing:event'
  readonly name: Name
  readonly topic: Topic
  readonly payload: Payload
  readonly key?: Key
}

export type EventingEventInput<E extends AnyEventingEvent> = {
  payload: t.infer.encode.input<E['payload']>
  headers?: EventingHeaders
} & (NonNullable<E['key']> extends BaseType
  ? { key: t.infer.encode.input<NonNullable<E['key']>> }
  : { key?: string })

export type EventingEventOutput<E extends AnyEventingEvent> = {
  name: E['name']
  topic: E['topic']
  payload: t.infer.decode.output<E['payload']>
  headers: EventingHeaders
} & (NonNullable<E['key']> extends BaseType
  ? { key: t.infer.decode.output<NonNullable<E['key']>> }
  : { key?: string })

export type EventingEventConfig<
  Name extends string,
  Topic extends string,
  Payload extends BaseType,
  Key extends BaseType | undefined = undefined,
> = { name: Name; topic: Topic; payload: Payload; key?: Key }

export function defineEvent<
  const Name extends string,
  const Topic extends string,
  Payload extends BaseType,
  Key extends BaseType | undefined = undefined,
>(
  config: EventingEventConfig<Name, Topic, Payload, Key>,
): EventingEvent<Name, Topic, Payload, Key> {
  return Object.freeze({
    type: 'nmtjs:eventing:event',
    name: config.name,
    topic: config.topic,
    payload: config.payload,
    key: config.key,
  }) as EventingEvent<Name, Topic, Payload, Key>
}
