import type { Async } from '@nmtjs/common'
import {
  c,
  type TAnyProcedureContract,
  type TProcedureContract,
} from '@nmtjs/contract'
import {
  type Dependant,
  type Dependencies,
  type DependencyContext,
  kMetadata,
  type Metadata,
  type MetadataKey,
  MetadataStore,
} from '@nmtjs/core'
import type {
  InputType,
  OutputType,
  ProtocolApiCallIterableResult,
} from '@nmtjs/protocol/server'
import { type BaseType, t } from '@nmtjs/type'
import type * as zod from 'zod/v4-mini'
import type { AnyGuard, AnyMiddleware } from './api.ts'
import { kProcedure } from './constants.ts'
import type { JsonPrimitive } from './types.ts'

export interface BaseProcedure<
  ProcedureContract extends TAnyProcedureContract,
  ProcedureDeps extends Dependencies,
> extends Dependant<ProcedureDeps> {
  contract: ProcedureContract
  handler: (...args: any[]) => any
  metadata: Map<MetadataKey, any>
  dependencies: ProcedureDeps
  guards: Set<AnyGuard>
  middlewares: Set<AnyMiddleware>
}

export type ProcedureHandlerType<Input, Output, Deps extends Dependencies> = (
  ctx: DependencyContext<Deps>,
  data: Input,
) => Async<Output>

export interface Procedure<
  ProcedureContract extends TAnyProcedureContract,
  ProcedureDeps extends Dependencies,
> extends BaseProcedure<ProcedureContract, ProcedureDeps> {
  handler: ProcedureHandlerType<
    InputType<t.infer.decoded.output<ProcedureContract['input']>>,
    ProcedureContract['stream'] extends t.NeverType
      ? OutputType<t.infer.decoded.input<ProcedureContract['output']>>
      : ProtocolApiCallIterableResult<
          t.infer.decoded.input<
            Exclude<ProcedureContract['stream'], undefined | boolean>
          >,
          OutputType<t.infer.decoded.input<ProcedureContract['output']>>
        >,
    ProcedureDeps
  >
  [kProcedure]: any
}

export type AnyProcedure<
  Contract extends TAnyProcedureContract = TAnyProcedureContract,
> = Procedure<Contract, Dependencies>

export const getProcedureMetadata = <
  K extends MetadataKey,
  T extends K extends MetadataKey<infer Type> ? Type : never,
  D extends T | undefined = undefined,
>(
  procedure: AnyProcedure,
  key: T,
  defaultValue?: D,
): D extends undefined ? T | undefined : T => {
  return procedure.metadata.get(key[kMetadata]) ?? defaultValue
}

export type CreateProcedureParams<
  ProcedureContract extends TAnyProcedureContract,
  ProcedureDeps extends Dependencies,
> =
  | {
      dependencies?: ProcedureDeps
      guards?: AnyGuard[]
      middlewares?: AnyMiddleware[]
      metadata?: Metadata[]
      handler: ProcedureHandlerType<
        InputType<t.infer.decoded.output<ProcedureContract['input']>>,
        ProcedureContract['stream'] extends t.NeverType
          ? OutputType<t.infer.decoded.input<ProcedureContract['output']>>
          : ProtocolApiCallIterableResult<
              t.infer.decoded.input<
                Exclude<ProcedureContract['stream'], undefined | boolean>
              >,
              OutputType<t.infer.decoded.input<ProcedureContract['output']>>
            >,
        ProcedureDeps
      >
    }
  | ProcedureHandlerType<
      InputType<t.infer.decoded.output<ProcedureContract['input']>>,
      ProcedureContract['stream'] extends t.NeverType
        ? OutputType<t.infer.decoded.input<ProcedureContract['output']>>
        : ProtocolApiCallIterableResult<
            t.infer.decoded.input<
              Exclude<ProcedureContract['stream'], undefined | boolean>
            >,
            OutputType<t.infer.decoded.input<ProcedureContract['output']>>
          >,
      ProcedureDeps
    >

export function _createBaseProcedure<
  ProcedureContract extends TAnyProcedureContract,
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
  const metadata = new MetadataStore()
  const middlewares = new Set(params.middlewares ?? [])
  const guards = new Set(params.guards ?? [])

  for (const meta of params.metadata ?? []) {
    metadata.set(meta.key, meta.value)
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
  ProcedureContract extends TAnyProcedureContract,
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
  Return,
  Stream,
  TInput extends BaseType | undefined = undefined,
  TOutput extends BaseType | undefined = undefined,
  TStream extends BaseType | true | undefined = undefined,
  Deps extends Dependencies = {},
>(
  paramsOrHandler:
    | {
        input?: TInput
        output?: TOutput
        stream?: TStream
        dependencies?: Deps
        guards?: AnyGuard[]
        middlewares?: AnyMiddleware[]
        metadata?: Metadata[]
        handler: ProcedureHandlerType<
          TInput extends BaseType
            ? InputType<t.infer.decoded.output<TInput>>
            : never,
          TStream extends undefined
            ? TOutput extends BaseType
              ? t.infer.decoded.input<TOutput>
              : Return
            : TOutput extends BaseType
              ? ProtocolApiCallIterableResult<
                  TStream extends true
                    ? Stream
                    : t.infer.decoded.input<
                        Exclude<TStream, undefined | boolean>
                      >,
                  t.infer.decoded.input<TOutput>
                >
              : ProtocolApiCallIterableResult<
                  TStream extends true
                    ? Stream
                    : t.infer.decoded.input<
                        Exclude<TStream, undefined | boolean>
                      >,
                  Return
                >,
          Deps
        >
      }
    | ProcedureHandlerType<
        TInput extends BaseType
          ? InputType<t.infer.decoded.output<TInput>>
          : never,
        TStream extends undefined
          ? TOutput extends BaseType
            ? never
            : Return
          : never,
        Deps
      >,
): Procedure<
  TProcedureContract<
    TInput extends BaseType ? TInput : t.NeverType,
    TOutput extends BaseType
      ? TOutput
      : t.CustomType<
          JsonPrimitive<Return>,
          zod.ZodMiniCustom<JsonPrimitive<Return>, JsonPrimitive<Return>>
        >,
    TStream extends BaseType
      ? TStream
      : TStream extends true
        ? t.CustomType<JsonPrimitive<Stream>>
        : t.NeverType
  >,
  Deps
> {
  const params =
    typeof paramsOrHandler === 'function'
      ? { handler: paramsOrHandler }
      : paramsOrHandler

  return createContractProcedure(
    c.procedure({
      input: (params.input ?? t.never()) as any,
      output: (params.output ?? t.any()) as any,
      stream: (typeof params.stream === 'undefined'
        ? t.never()
        : params.stream === true
          ? t.any()
          : params.stream) as any,
    }),
    {
      dependencies: params.dependencies,
      handler: params.handler,
      guards: params.guards,
      middlewares: params.middlewares,
      metadata: params.metadata,
    },
  )
}
