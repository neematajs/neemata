import type { ContractSchemaOptions } from '../utils.ts'
import type { TAnyRouterContract } from './router.ts'
import { Kind } from '../constants.ts'
import { createSchema } from '../utils.ts'

export const APIKind = Symbol('NeemataAPI')

export type TAnyAPIContract = TAPIContract<TAnyRouterContract>

export interface TAPIContract<
  Router extends TAnyRouterContract = TAnyRouterContract,
> {
  readonly [Kind]: typeof APIKind
  readonly type: 'neemata:api'
  readonly router: Router
  readonly timeout?: number
}

export const APIContract = <
  const Options extends {
    router: TAnyRouterContract
    timeout?: number
    schemaOptions?: ContractSchemaOptions
  },
>(
  options: Options,
) => {
  const { router, timeout, schemaOptions } = options
  return createSchema<TAPIContract<Options['router']>>({
    ...schemaOptions,
    [Kind]: APIKind,
    type: 'neemata:api',
    router,
    timeout,
  })
}

export function IsAPIContract(value: any): value is TAnyAPIContract {
  return Kind in value && value[Kind] === APIKind
}
