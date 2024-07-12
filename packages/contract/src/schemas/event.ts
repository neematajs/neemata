import { Kind, type StaticDecode, type TSchema } from '@sinclair/typebox/type'
import { type NeemataContractSchemaOptions, createSchema } from '../utils'

export const EventKind = 'NeemataEvent'

export interface TEventContract<Payload extends TSchema = any> extends TSchema {
  [Kind]: typeof EventKind
  static: {
    payload: StaticDecode<Payload>
  }
  type: 'neemata:event'
  payload: Payload
}

export const EventContract = <
  Payload extends TSchema,
  SOptions extends NeemataContractSchemaOptions,
>(
  payload: Payload,
  schemaOptions: SOptions = {} as SOptions,
) =>
  createSchema<TEventContract<Payload>>({
    ...schemaOptions,
    [Kind]: EventKind,
    type: 'neemata:event',
    payload,
  })
