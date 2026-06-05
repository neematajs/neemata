import type { BaseType, BaseTypeAny } from '@nmtjs/type'
import { t } from '@nmtjs/type'

import type { ContractSchemaOptions } from '../utils.ts'
import { Kind } from '../constants.ts'
import { createSchema } from '../utils.ts'

export const EventKind = Symbol('NeemataEvent')

export type TAnyEventContract = TEventContract<BaseTypeAny>

export interface TEventContract<Payload extends BaseType = t.NeverType> {
  readonly [Kind]: typeof EventKind
  readonly type: 'neemata:event'
  readonly payload: Payload
}

export const EventContract = <
  Payload extends BaseType = t.NeverType,
>(options?: {
  payload?: Payload
  schemaOptions?: ContractSchemaOptions
}) => {
  const { payload = t.never() as unknown as Payload, schemaOptions = {} } =
    options ?? {}
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
