import type { BaseType } from '@nmtjs/type'
import { Kind } from '../constants.ts'
import { type ContractSchemaOptions, createSchema } from '../utils.ts'

export const EventKind = 'NeemataEvent'

export interface TEventContract<
  Payload extends BaseType = BaseType,
  Name extends string | undefined = string | undefined,
  ServiceName extends string | undefined = string | undefined,
  SubscriptionName extends string | undefined = string | undefined,
> {
  [Kind]: typeof EventKind
  type: 'neemata:event'
  name: Name
  serviceName: ServiceName
  subscriptionName: SubscriptionName
  payload: Payload
}

export const EventContract = <Payload extends BaseType>(
  payload: Payload,
  schemaOptions: ContractSchemaOptions = {} as ContractSchemaOptions,
) => {
  return createSchema<TEventContract<Payload>>({
    ...schemaOptions,
    [Kind]: EventKind,
    type: 'neemata:event',
    payload,
    name: undefined,
    serviceName: undefined,
    subscriptionName: undefined,
  })
}

export function IsEventContract(value: any): value is TEventContract {
  return Kind in value && value[Kind] === EventKind
}
