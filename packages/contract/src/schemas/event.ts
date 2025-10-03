import type { BaseType } from '@nmtjs/type'
import { t } from '@nmtjs/type'

import type { ContractSchemaOptions } from '../utils.ts'
import type { SubcriptionOptions } from './subscription.ts'
import { Kind } from '../constants.ts'
import { createSchema } from '../utils.ts'

export const EventKind = Symbol('NeemataEvent')

export type TAnyEventContract = TEventContract<
  BaseType,
  string | undefined,
  SubcriptionOptions | undefined
>

export interface TEventContract<
  Payload extends BaseType = t.NeverType,
  Name extends string | undefined = undefined,
  Options extends SubcriptionOptions | undefined = undefined,
> {
  readonly [Kind]: typeof EventKind
  readonly type: 'neemata:event'
  readonly name: Name
  readonly payload: Payload
  readonly options: Options
}

export const EventContract = <
  Payload extends BaseType,
  Name extends string | undefined = undefined,
  Options extends SubcriptionOptions | undefined = undefined,
>(options?: {
  payload?: Payload
  schemaOptions?: ContractSchemaOptions
  name?: Name
}) => {
  const {
    payload = t.never() as unknown as Payload,
    schemaOptions = {},
    name = undefined as any,
  } = options ?? {}
  return createSchema<TEventContract<Payload, Name, Options>>({
    ...schemaOptions,
    [Kind]: EventKind,
    type: 'neemata:event',
    payload,
    name,
    options: undefined as Options,
  })
}

export function IsEventContract(value: any): value is TAnyEventContract {
  return Kind in value && value[Kind] === EventKind
}
