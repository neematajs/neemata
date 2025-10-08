import type { Async } from '@nmtjs/common'
import type { TAnyProcedureContract, TProcedureContract } from '@nmtjs/contract'
import type {
  Dependant,
  Dependencies,
  DependencyContext,
  Metadata,
  MetadataKey,
} from '@nmtjs/core'
import type {
  InputType,
  OutputType,
  ProtocolApiCallIterableResult,
} from '@nmtjs/protocol/server'
import type { BaseType } from '@nmtjs/type'
import type * as zod from 'zod/mini'
import { c } from '@nmtjs/contract'
import { kMetadata, MetadataStore } from '@nmtjs/core'
import { t } from '@nmtjs/type'

import type { AnyGuard, AnyMiddleware } from './api.ts'
import type { JsonPrimitive } from './types.ts'
import { kProcedure } from './constants.ts'

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
  [kProcedure]: any
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
    InputType<t.infer.decode.output<ProcedureContract['input']>>,
    ProcedureContract['stream'] extends t.NeverType
      ? OutputType<t.infer.decode.input<ProcedureContract['output']>>
      : ProtocolApiCallIterableResult<
          t.infer.decode.input<
            Exclude<ProcedureContract['stream'], undefined | boolean>
          >,
          OutputType<t.infer.decode.input<ProcedureContract['output']>>
        >,
    ProcedureDeps
  >
}

export type AnyProcedure<
  Contract extends TAnyProcedureContract = TAnyProcedureContract,
> = BaseProcedure<Contract, Dependencies>

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
        InputType<t.infer.decode.output<ProcedureContract['input']>>,
        ProcedureContract['stream'] extends undefined
          ? OutputType<t.infer.decode.input<ProcedureContract['output']>>
          : ProtocolApiCallIterableResult<
              t.infer.decode.input<
                Exclude<ProcedureContract['stream'], undefined | boolean>
              >,
              OutputType<t.infer.decode.input<ProcedureContract['output']>>
            >,
        ProcedureDeps
      >
    }
  | ProcedureHandlerType<
      InputType<t.infer.decode.output<ProcedureContract['input']>>,
      ProcedureContract['stream'] extends undefined
        ? OutputType<t.infer.decode.input<ProcedureContract['output']>>
        : ProtocolApiCallIterableResult<
            t.infer.decode.input<
              Exclude<ProcedureContract['stream'], undefined | boolean>
            >,
            OutputType<t.infer.decode.input<ProcedureContract['output']>>
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

  return { contract, dependencies, middlewares, guards, metadata }
}

export function createContractProcedure<
  ProcedureContract extends TAnyProcedureContract,
  ProcedureDeps extends Dependencies,
>(
  contract: ProcedureContract,
  paramsOrHandler: CreateProcedureParams<ProcedureContract, ProcedureDeps>,
): Procedure<ProcedureContract, ProcedureDeps> {
  const { handler, ...params } =
    typeof paramsOrHandler === 'function'
      ? { handler: paramsOrHandler }
      : paramsOrHandler

  return Object.assign(_createBaseProcedure(contract, params), {
    handler,
    [kProcedure]: true,
  }) as any
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
        timeout?: number
        handler: ProcedureHandlerType<
          TInput extends BaseType
            ? InputType<t.infer.decode.output<TInput>>
            : never,
          TStream extends BaseType | true
            ? ProtocolApiCallIterableResult<
                TStream extends BaseType
                  ? t.infer.decode.input<TStream>
                  : Stream,
                TOutput extends BaseType
                  ? t.infer.decode.input<TOutput>
                  : Return
              >
            : TOutput extends BaseType
              ? t.infer.decode.input<TOutput>
              : Return,
          Deps
        >
      }
    | ProcedureHandlerType<
        TInput extends BaseType
          ? InputType<t.infer.decode.output<TInput>>
          : never,
        Return,
        Deps
      >,
): Procedure<
  TProcedureContract<
    TInput extends undefined ? t.NeverType : TInput,
    TOutput extends undefined
      ? t.CustomType<
          JsonPrimitive<Return>,
          zod.ZodMiniCustom<JsonPrimitive<Return>, JsonPrimitive<Return>>
        >
      : TOutput,
    TStream extends undefined
      ? undefined
      : TStream extends BaseType
        ? TStream
        : t.CustomType<JsonPrimitive<Stream>>
  >,
  Deps
> {
  const {
    input = t.never() as any,
    output = t.any() as any,
    stream = undefined as any,
    dependencies = {} as Deps,
    guards = [],
    middlewares = [],
    metadata = [],
    handler,
    timeout,
  } = typeof paramsOrHandler === 'function'
    ? { handler: paramsOrHandler }
    : paramsOrHandler

  return createContractProcedure(
    c.procedure({
      input,
      output,
      stream: stream === true ? t.any() : stream,
      timeout,
    }),
    { dependencies, handler, guards, middlewares, metadata },
  )
}

export const isProcedure = (value: any): value is AnyProcedure =>
  Boolean(value?.[kProcedure])
