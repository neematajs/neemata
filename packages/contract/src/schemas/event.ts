import { type BaseType, t } from '@nmtjs/type'
import { Kind } from '../constants.ts'
import { type ContractSchemaOptions, createSchema } from '../utils.ts'

export const EventKind = 'NeemataEvent'

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
  [Kind]: typeof EventKind
  type: 'neemata:event'
  name: Name
  subscription: Subscription
  namespace: Namespace
  payload: Payload
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
