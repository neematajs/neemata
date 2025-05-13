import {
  c,
  type TAnyBaseProcedureContract,
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
  ProtocolAnyIterable,
  ProtocolApiCallIterableResult,
} from '@nmtjs/protocol/server'
import {
  type BaseType,
  type CustomType,
  type NeverType,
  t,
  type zod,
} from '@nmtjs/type'
import type { AnyGuard, AnyMiddleware } from './api.ts'
import { kIterableResponse, kProcedure } from './constants.ts'
import type { Async, JsonPrimitive } from './types.ts'

export interface BaseProcedure<
  ProcedureContract extends TAnyBaseProcedureContract,
  ProcedureDeps extends Dependencies,
> extends Dependant<ProcedureDeps> {
  contract: ProcedureContract
  handler: (...args: any[]) => any
  metadata: Map<MetadataKey, any>
  dependencies: ProcedureDeps
  guards: Set<AnyGuard>
  middlewares: Set<AnyMiddleware>
}

export type AnyBaseProcedure<
  Contract extends TAnyBaseProcedureContract = TAnyBaseProcedureContract,
> = BaseProcedure<Contract, Dependencies>

export type ProcedureHandlerType<Input, Output, Deps extends Dependencies> = (
  ctx: DependencyContext<Deps>,
  data: Input,
  contract: TAnyBaseProcedureContract,
) => Async<Output>

export interface Procedure<
  ProcedureContract extends TAnyProcedureContract,
  ProcedureDeps extends Dependencies,
> extends BaseProcedure<ProcedureContract, ProcedureDeps> {
  handler: ProcedureHandlerType<
    InputType<t.infer.decoded.output<ProcedureContract['input']>>,
    ProcedureContract['stream'] extends NeverType
      ? OutputType<t.infer.decoded.input<ProcedureContract['output']>>
      : RPCStreamResponse<
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
  procedure: AnyBaseProcedure,
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
        ProcedureContract['stream'] extends NeverType
          ? OutputType<t.infer.decoded.input<ProcedureContract['output']>>
          : RPCStreamResponse<
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
      ProcedureContract['stream'] extends NeverType
        ? OutputType<t.infer.decoded.input<ProcedureContract['output']>>
        : RPCStreamResponse<
            t.infer.decoded.input<
              Exclude<ProcedureContract['stream'], undefined | boolean>
            >,
            OutputType<t.infer.decoded.input<ProcedureContract['output']>>
          >,
      ProcedureDeps
    >

export function _createBaseProcedure<
  ProcedureContract extends TAnyBaseProcedureContract,
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

export interface RPCStreamResponse<Y = unknown, O = unknown>
  extends ProtocolApiCallIterableResult {
  [kIterableResponse]: true
  iterable: ProtocolAnyIterable<Y>
  output: O
  onFinish?: () => void
}

export function isIterableResponse(value: any): value is RPCStreamResponse {
  return value && value[kIterableResponse] === true
}

export function createStreamResponse<Y, O>(
  iterable: ProtocolAnyIterable<Y>,
  {
    onFinish,
    output = undefined as O,
  }: {
    output?: O
    onFinish?: () => void
  },
): RPCStreamResponse<Y, O> {
  return {
    [kIterableResponse]: true as const,
    iterable,
    output,
    onFinish,
  }
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
              ? RPCStreamResponse<
                  TStream extends true
                    ? Stream
                    : t.infer.decoded.input<
                        Exclude<TStream, undefined | boolean>
                      >,
                  t.infer.decoded.input<TOutput>
                >
              : RPCStreamResponse<
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
    TInput extends BaseType ? TInput : NeverType,
    TOutput extends BaseType
      ? TOutput
      : CustomType<
          JsonPrimitive<Return>,
          zod.ZodMiniCustom<JsonPrimitive<Return>, JsonPrimitive<Return>>
        >,
    TStream extends BaseType
      ? TStream
      : TStream extends true
        ? CustomType<JsonPrimitive<Stream>>
        : NeverType
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
