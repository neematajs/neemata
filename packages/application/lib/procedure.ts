import type {
  TBaseProcedureContract,
  TProcedureContract,
  TSubscriptionContract,
} from '@nmtjs/contract'
import type { NeverType, t } from '@nmtjs/type'
import type {
  AnyInjectable,
  Dependant,
  Dependencies,
  DependencyContext,
} from './container.ts'

import { ProcedureKey, ProcedureMetadataKey } from './constants.ts'
import type { SubscriptionResponse } from './subscription.ts'
import type {
  Async,
  ErrorClass,
  ExecuteContext,
  InputType,
  OutputType,
} from './types.ts'

export type ProcedureHandlerType<
  ProcedureContract extends TBaseProcedureContract,
  Deps extends Dependencies,
> = (
  ctx: DependencyContext<Deps>,
  data: ProcedureContract['input'] extends NeverType
    ? never
    : InputType<t.infer.decoded<ProcedureContract['input']>>,
) => Async<
  ProcedureContract extends TProcedureContract
    ? ProcedureContract['output'] extends NeverType
      ? void
      : OutputType<t.infer.decoded<ProcedureContract['output']>>
    : ProcedureContract extends TSubscriptionContract
      ? ProcedureContract['output'] extends NeverType
        ? SubscriptionResponse<any, never, never>
        : SubscriptionResponse<
            any,
            OutputType<t.infer.decoded<ProcedureContract['output']>>,
            OutputType<t.infer.decoded<ProcedureContract['output']>>
          >
      : never
>

export interface Procedure<
  ProcedureContract extends TBaseProcedureContract = TBaseProcedureContract,
  ProcedureDeps extends Dependencies = Dependencies,
> extends Dependant<ProcedureDeps> {
  contract: ProcedureContract
  handler: ProcedureHandlerType<ProcedureContract, ProcedureDeps>
  metadata: Map<string, any>
  dependencies: ProcedureDeps
  guards: Set<AnyGuard>
  middlewares: Set<AnyMiddleware>
  [ProcedureKey]: any
}

export interface FilterLike<T extends ErrorClass = ErrorClass> {
  catch(error: InstanceType<T>): Async<Error>
}

export interface GuardLike {
  can(context: ExecuteContext): Async<boolean>
}

export type MiddlewareNext = (payload?: any) => any

export interface MiddlewareLike {
  handle(context: ExecuteContext, next: MiddlewareNext, payload: any): any
}

export type AnyGuard = AnyInjectable<GuardLike>
export type AnyMiddleware = AnyInjectable<MiddlewareLike>
export type AnyFilter<Error extends ErrorClass = ErrorClass> = AnyInjectable<
  FilterLike<Error>
>

export type AnyProcedureContract = TSubscriptionContract | TProcedureContract

export type AnyProcedure<Contract extends AnyProcedureContract = any> =
  Procedure<Contract, Dependencies>

export type Metadata<T = any> = {
  key: MetadataKey<T>
  value: T
}

export type MetadataKey<T = any> = {
  [ProcedureMetadataKey]: string
  as(value: T): Metadata<T>
}

export const createProcedureMetadataKey = <T>(key: string): MetadataKey<T> => {
  const metadataKey = {
    [ProcedureMetadataKey]: key,
    as(value: T) {
      return { key: metadataKey, value }
    },
  }
  return metadataKey
}

export const getProcedureMetadata = <
  K extends MetadataKey,
  T extends K extends MetadataKey<infer Type> ? Type : never,
  D extends T | undefined = undefined,
>(
  procedure: AnyProcedure,
  key: T,
  defaultValue?: D,
): D extends undefined ? T | undefined : T => {
  return procedure.metadata.get(key[ProcedureMetadataKey]) ?? defaultValue
}

export type CreateProcedureParams<
  ProcedureContract extends AnyProcedureContract,
  ProcedureDeps extends Dependencies,
> =
  | {
      handler: ProcedureHandlerType<ProcedureContract, ProcedureDeps>
      dependencies?: ProcedureDeps
      middlewares?: AnyMiddleware[]
      guards?: AnyGuard[]
      metadata?: Metadata[]
    }
  | ProcedureHandlerType<ProcedureContract, ProcedureDeps>

export function createContractProcedure<
  ProcedureContract extends AnyProcedureContract,
  ProcedureDeps extends Dependencies,
>(
  contract: ProcedureContract,
  paramsOrProcedure: CreateProcedureParams<ProcedureContract, ProcedureDeps>,
): Procedure<ProcedureContract, ProcedureDeps> {
  const params =
    typeof paramsOrProcedure === 'function'
      ? { handler: paramsOrProcedure }
      : paramsOrProcedure

  const dependencies = params.dependencies ?? ({} as ProcedureDeps)
  const metadata = new Map()
  const middlewares = new Set(params.middlewares ?? [])
  const guards = new Set(params.guards ?? [])

  for (const meta of params.metadata ?? []) {
    const key = meta.key[ProcedureMetadataKey]
    metadata.set(key, meta.value)
  }

  return {
    contract,
    handler: params.handler,
    dependencies,
    middlewares,
    guards,
    metadata,
    [ProcedureKey]: true,
  }
}

// export function createProcedure<
//   R,
//   I extends BaseType = NeverType,
//   O extends BaseType = AnyType,
//   D extends Dependencies = {},
// >(params: {
//   input?: I
//   output?: O
//   dependencies?: D
//   guards?: AnyGuard[]
//   middlewares?: AnyMiddleware[]
//   metadata?: Metadata[]
//   handler(
//     ctx: DependencyContext<D>,
//     data: I extends NeverType ? never : InputType<t.infer.decoded<I>>,
//   ): Async<R>
// }): Procedure<TProcedureContract<I, O>, D> {
//   return createContractProcedure(
//     {
//       type: 'neemata:procedure',
//       input: params.input ?? t.never() as unknown as I,
//       output: params.output ?? t.any() as O,
//       name: undefined,
//       serviceName: undefined,
//       transports: undefined,
//       timeout: undefined,
//     } satisfies TProcedureContract<I, O> as TProcedureContract<I, O>,
//     {
//       dependencies: params.dependencies,
//       handler: params.handler as any,
//       guards: params.guards,
//       middlewares: params.middlewares,
//       metadata: params.metadata,
//     },
//   )
// }
