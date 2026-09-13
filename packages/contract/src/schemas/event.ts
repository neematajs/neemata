import type { WireSchema } from '@nmtjs/common/schema'
import { isWireSchemaCodec } from '@nmtjs/common/schema'

import type { ContractSchemaOptions } from '../utils.ts'
import { Kind } from '../constants.ts'
import { createSchema } from '../utils.ts'

export const EventKind = Symbol('NeemataEvent')

export type TAnyEventContract = TEventContract<WireSchema.Codec | undefined>

export interface TEventContract<
  Payload extends WireSchema.Codec | undefined = undefined,
> {
  readonly [Kind]: typeof EventKind
  readonly type: 'neemata:event'
  readonly payload: Payload
}

export const EventContract = <
  Payload extends WireSchema.Codec | undefined = undefined,
>(options?: {
  payload?: Payload
  schemaOptions?: ContractSchemaOptions
}) => {
  const payload = options?.payload as Payload
  const schemaOptions = options?.schemaOptions ?? {}
  if (payload !== undefined && !isWireSchemaCodec(payload)) {
    throw new TypeError('Event payload must be a WireSchema.Codec')
  }
  return createSchema<TEventContract<Payload>>({
    ...schemaOptions,
    [Kind]: EventKind,
    type: 'neemata:event',
    payload,
  })
}

export function IsEventContract(value: any): value is TAnyEventContract {
  return Kind in value && value[Kind] === EventKind
}
