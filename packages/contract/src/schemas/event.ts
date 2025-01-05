import type { BaseType, BaseTypeAny } from '@nmtjs/type'
import { type ContractSchemaOptions, createSchema } from '../utils.ts'

export const EventKind = 'NeemataEvent'

export interface TEventContract<
  Payload extends BaseTypeAny = BaseTypeAny,
  Name extends string | undefined = string | undefined,
  ServiceName extends string | undefined = string | undefined,
  SubscriptionName extends string | undefined = string | undefined,
> {
  type: 'neemata:event'
  name: Name
  serviceName: ServiceName
  subscriptionName: SubscriptionName
  payload: Payload
}

export const EventContract = <Payload extends BaseTypeAny>(
  payload: Payload,
  schemaOptions: ContractSchemaOptions = {} as ContractSchemaOptions,
) => {
  return createSchema<TEventContract<Payload>>({
    ...schemaOptions,
    type: 'neemata:event',
    payload,
    name: undefined,
    serviceName: undefined,
    subscriptionName: undefined,
  })
}
