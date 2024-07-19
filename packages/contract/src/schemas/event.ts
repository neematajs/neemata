import { Kind, type TSchema } from '@sinclair/typebox/type'
import { type ContractSchemaOptions, createSchema } from '../utils.ts'

export const EventKind = 'NeemataEvent'

export interface TEventContract<
  Payload extends TSchema = any,
  Name extends string | undefined = string | undefined,
  ServiceName extends string | undefined = string | undefined,
  SubscriptionName extends string | undefined = string | undefined,
> extends TSchema {
  [Kind]: typeof EventKind
  type: 'neemata:event'
  static: {
    payload: Payload['static']
  }
  name: Name
  serviceName: ServiceName
  subscriptionName: SubscriptionName
  payload: Payload
}

export const EventContract = <Payload extends TSchema>(
  payload: Payload,
  schemaOptions: ContractSchemaOptions = {} as ContractSchemaOptions,
) =>
  createSchema<TEventContract<Payload>>({
    ...schemaOptions,
    [Kind]: EventKind,
    type: 'neemata:event',
    payload,
  })
