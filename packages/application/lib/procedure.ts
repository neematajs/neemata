import {
  type TBaseProcedureContract,
  type TProcedureContract,
  c,
} from '@nmtjs/contract'
import { type BaseType, type CustomType, type NeverType, t } from '@nmtjs/type'

import { type Scope, kProcedure, kProcedureMetadata } from './constants.ts'
import {
  type AnyInjectable,
  type Dependant,
  type Dependencies,
  type DependencyContext,
  createFactoryInjectable,
} from './container.ts'
import type {
  Async,
  CallContext,
  ErrorClass,
  InputType,
  JsonPrimitive,
  OutputType,
} from './types.ts'

export interface FilterLike<T extends ErrorClass = ErrorClass> {
  catch(error: InstanceType<T>): Async<Error>
}
export type AnyFilter<Error extends ErrorClass = ErrorClass> = AnyInjectable<
  FilterLike<Error>
>
export interface GuardLike {
  can(context: CallContext): Async<boolean>
}
export type AnyGuard = AnyInjectable<GuardLike>

export type MiddlewareNext = (payload?: any) => any

export interface MiddlewareLike {
  handle(context: CallContext, next: MiddlewareNext, payload: any): any
}
export type AnyMiddleware = AnyInjectable<MiddlewareLike>

export interface BaseProcedure<
  ProcedureContract extends TBaseProcedureContract = TBaseProcedureContract,
  ProcedureDeps extends Dependencies = Dependencies,
> extends Dependant<ProcedureDeps> {
  contract: ProcedureContract
  handler: (...args: any[]) => any
  metadata: Map<string, any>
  dependencies: ProcedureDeps
  guards: Set<AnyGuard>
  middlewares: Set<AnyMiddleware>
}

export type AnyBaseProcedure<
  Contract extends TBaseProcedureContract = TBaseProcedureContract,
> = BaseProcedure<Contract, Dependencies>

export type ProcedureHandlerType<
  Input extends BaseType,
  Output extends BaseType,
  Deps extends Dependencies,
> = (
  ctx: DependencyContext<Deps>,
  data: Input extends NeverType ? never : InputType<t.infer.decoded<Input>>,
) => Async<
  Output extends NeverType ? void : OutputType<t.infer.decoded<Output>>
>

export interface Procedure<
  ProcedureContract extends TBaseProcedureContract = TBaseProcedureContract,
  ProcedureDeps extends Dependencies = Dependencies,
> extends BaseProcedure<ProcedureContract, ProcedureDeps> {
  handler: ProcedureHandlerType<
    ProcedureContract['input'],
    ProcedureContract['output'],
    ProcedureDeps
  >
  [kProcedure]: any
}
export type AnyProcedure<Contract extends TBaseProcedureContract = any> =
  Procedure<Contract, Dependencies>

export type Metadata<T = any> = {
  key: MetadataKey<T>
  value: T
}

export type MetadataKey<T = any> = {
  [kProcedureMetadata]: string
  as(value: T): Metadata<T>
}

export const createProcedureMetadataKey = <T>(key: string): MetadataKey<T> => {
  const metadataKey = {
    [kProcedureMetadata]: key,
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
  procedure: AnyBaseProcedure,
  key: T,
  defaultValue?: D,
): D extends undefined ? T | undefined : T => {
  return procedure.metadata.get(key[kProcedureMetadata]) ?? defaultValue
}

export type CreateProcedureParams<
  ProcedureContract extends TBaseProcedureContract,
  ProcedureDeps extends Dependencies,
> =
  | {
      handler: ProcedureHandlerType<
        ProcedureContract['input'],
        ProcedureContract['output'],
        ProcedureDeps
      >
      dependencies?: ProcedureDeps
      middlewares?: AnyMiddleware[]
      guards?: AnyGuard[]
      metadata?: Metadata[]
    }
  | ProcedureHandlerType<
      ProcedureContract['input'],
      ProcedureContract['output'],
      ProcedureDeps
    >

export function _createBaseProcedure<
  ProcedureContract extends TBaseProcedureContract,
  ProcedureDeps extends Dependencies,
>(
  contract: ProcedureContract,
  params: {
    dependencies?: ProcedureDeps
    middlewares?: AnyMiddleware[]
    guards?: AnyGuard[]
    metadata?: Metadata[]
  },
) {
  const dependencies = params.dependencies ?? ({} as ProcedureDeps)
  const metadata = new Map()
  const middlewares = new Set(params.middlewares ?? [])
  const guards = new Set(params.guards ?? [])

  for (const meta of params.metadata ?? []) {
    const key = meta.key[kProcedureMetadata]
    metadata.set(key, meta.value)
  }

  return {
    contract,
    dependencies,
    middlewares,
    guards,
    metadata,
  }
}

export function createContractProcedure<
  ProcedureContract extends TBaseProcedureContract,
  ProcedureDeps extends Dependencies,
>(
  contract: ProcedureContract,
  paramsOrHandler: CreateProcedureParams<ProcedureContract, ProcedureDeps>,
) {
  const { handler, ...params } =
    typeof paramsOrHandler === 'function'
      ? { handler: paramsOrHandler }
      : paramsOrHandler

  return Object.assign(_createBaseProcedure(contract, params), {
    handler,
    [kProcedure]: true,
  })
}

export function createProcedure<
  R,
  I extends BaseType | undefined = undefined,
  O extends BaseType | undefined = undefined,
  D extends Dependencies = {},
>(
  paramsOrHandler:
    | {
        input?: I
        output?: O
        dependencies?: D
        guards?: AnyGuard[]
        middlewares?: AnyMiddleware[]
        metadata?: Metadata[]
        handler: (
          ctx: DependencyContext<D>,
          data: I extends BaseType ? InputType<t.infer.decoded<I>> : never,
        ) => Async<O extends BaseType ? t.infer.decoded<O> : R>
      }
    | ((
        ctx: DependencyContext<D>,
        data: I extends BaseType ? InputType<t.infer.decoded<I>> : never,
      ) => Async<O extends BaseType ? t.infer.decoded<O> : R>),
): Procedure<
  TProcedureContract<
    I extends BaseType ? I : NeverType,
    O extends BaseType ? O : CustomType<R, JsonPrimitive<R>>
  >,
  D
> {
  const params =
    typeof paramsOrHandler === 'function'
      ? { handler: paramsOrHandler }
      : paramsOrHandler

  return createContractProcedure(
    c.procedure(
      (params.input ?? t.never()) as any,
      (params.output ?? t.any()) as any,
    ),
    {
      dependencies: params.dependencies,
      handler: params.handler as any,
      guards: params.guards,
      middlewares: params.middlewares,
      metadata: params.metadata,
    },
  )
}

export const createMiddleware = <
  D extends Dependencies = {},
  S extends Scope = Scope.Global,
>(
  ...args: Parameters<typeof createFactoryInjectable<MiddlewareLike, D, S>>
) => createFactoryInjectable(...args)

export const createGuard = <
  D extends Dependencies = {},
  S extends Scope = Scope.Global,
>(
  ...args: Parameters<typeof createFactoryInjectable<GuardLike, D, S>>
) => createFactoryInjectable(...args)

export const createFilter = <
  D extends Dependencies = {},
  S extends Scope = Scope.Global,
>(
  ...args: Parameters<typeof createFactoryInjectable<FilterLike, D, S>>
) => createFactoryInjectable(...args)
