import type { BaseType, t } from '@nmtjs/type'

import type { ContractSchemaOptions } from '../utils.ts'
import { Kind } from '../constants.ts'
import { createSchema } from '../utils.ts'

export const EventStreamKind = Symbol('NeemataEventStream')

export type EventStreamHeaders = Record<string, string>

export type TAnyEventStreamContract = TEventStreamContract<
  BaseType,
  string,
  string,
  BaseType | undefined
>

export interface TEventStreamContract<
  Payload extends BaseType,
  Name extends string = string,
  Topic extends string = string,
  Key extends BaseType | undefined = undefined,
> {
  readonly [Kind]: typeof EventStreamKind
  readonly type: 'neemata:event-stream'
  readonly name: Name
  readonly topic: Topic
  readonly payload: Payload
  readonly key?: Key
}

export type EventStreamProduceInput<E extends TAnyEventStreamContract> = {
  payload: t.infer.encode.input<E['payload']>
  headers?: EventStreamHeaders
} & (NonNullable<E['key']> extends BaseType
  ? { key: t.infer.encode.input<NonNullable<E['key']>> }
  : { key?: string })

export type EventStreamConsumeOutput<E extends TAnyEventStreamContract> = {
  name: E['name']
  topic: E['topic']
  payload: t.infer.decode.output<E['payload']>
  headers: EventStreamHeaders
} & (NonNullable<E['key']> extends BaseType
  ? { key: t.infer.decode.output<NonNullable<E['key']>> }
  : { key?: string })

export const EventStreamContract = <
  const Options extends {
    name: string
    topic: string
    payload: BaseType
    key?: BaseType
    schemaOptions?: ContractSchemaOptions
  },
>(
  options: Options,
): TEventStreamContract<
  Options['payload'],
  Options['name'],
  Options['topic'],
  Options['key'] extends BaseType ? Options['key'] : undefined
> => {
  const { schemaOptions = {}, key } = options
  return createSchema({
    ...schemaOptions,
    [Kind]: EventStreamKind,
    type: 'neemata:event-stream',
    name: options.name,
    topic: options.topic,
    payload: options.payload,
    key,
  }) as TEventStreamContract<
    Options['payload'],
    Options['name'],
    Options['topic'],
    Options['key'] extends BaseType ? Options['key'] : undefined
  >
}

export function IsEventStreamContract(
  contract: any,
): contract is TAnyEventStreamContract {
  return Kind in contract && contract[Kind] === EventStreamKind
}
