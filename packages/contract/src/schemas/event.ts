import type { BaseType } from '@nmtjs/type'
import { t } from '@nmtjs/type'

import type { ContractSchemaOptions } from '../utils.ts'
import { Kind } from '../constants.ts'
import { createSchema } from '../utils.ts'

export const EventKind = Symbol('NeemataEvent')

export type TAnyEventContract = TEventContract<
  BaseType,
  string | undefined,
  string | undefined,
  string | undefined
>

export interface TEventContract<
  Payload extends BaseType = t.NeverType,
  Name extends string | undefined = undefined,
  Subscription extends string | undefined = undefined,
  Namespace extends string | undefined = undefined,
> {
  readonly [Kind]: typeof EventKind
  readonly type: 'neemata:event'
  readonly name: Name
  readonly subscription: Subscription
  readonly namespace: Namespace
  readonly payload: Payload
}

export const EventContract = <
  Payload extends BaseType,
  Name extends string | undefined = undefined,
>(options?: {
  payload?: Payload
  schemaOptions?: ContractSchemaOptions
  name?: Name
}) => {
  const {
    payload = t.never() as unknown as Payload,
    schemaOptions = {},
    name,
  } = options ?? {}
  return createSchema<TEventContract<Payload, Name>>({
    ...schemaOptions,
    [Kind]: EventKind,
    type: 'neemata:event',
    payload,
    name: name as Name,
    subscription: undefined,
    namespace: undefined,
  })
}

export function IsEventContract(value: any): value is TAnyEventContract {
  return Kind in value && value[Kind] === EventKind
}
