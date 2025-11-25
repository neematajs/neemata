import type { Async } from '@nmtjs/common'
import type { TAnyProcedureContract, TProcedureContract } from '@nmtjs/contract'
import type {
  Dependant,
  Dependencies,
  DependencyContext,
  Metadata,
} from '@nmtjs/core'
import type { InputType } from '@nmtjs/protocol/server'
import type { BaseType } from '@nmtjs/type'
import type * as zod from 'zod/mini'
import { c } from '@nmtjs/contract'
import { MetadataStore } from '@nmtjs/core'
import { t } from '@nmtjs/type'

import type { AnyGuard } from './guards.ts'
import type { AnyMiddleware } from './middlewares.ts'
import type { JsonPrimitive } from './types.ts'
import { kProcedure } from './constants.ts'

export interface BaseProcedure<
  ProcedureContract extends TAnyProcedureContract,
  ProcedureDeps extends Dependencies,
> extends Dependant<ProcedureDeps> {
  contract: ProcedureContract
  handler: (...args: any[]) => any
  metadata: MetadataStore
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
    InputType<t.infer.decodeRaw.output<ProcedureContract['input']>>,
    ProcedureContract['stream'] extends true
      ? AsyncIterable<t.infer.encode.input<ProcedureContract['output']>>
      : t.infer.encode.input<ProcedureContract['output']>,
    ProcedureDeps
  >
}

export type AnyProcedure<
  Contract extends TAnyProcedureContract = TAnyProcedureContract,
> = BaseProcedure<Contract, Dependencies>

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
        InputType<t.infer.decodeRaw.output<ProcedureContract['input']>>,
        ProcedureContract['stream'] extends undefined
          ? t.infer.encode.input<ProcedureContract['output']>
          : AsyncIterable<
              Exclude<ProcedureContract['stream'], undefined | boolean>
            >,
        ProcedureDeps
      >
    }
  | ProcedureHandlerType<
      InputType<t.infer.decodeRaw.output<ProcedureContract['input']>>,
      ProcedureContract['stream'] extends undefined
        ? t.infer.decode.input<ProcedureContract['output']>
        : AsyncIterable<
            Exclude<ProcedureContract['stream'], undefined | boolean>
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
  TInput extends BaseType | undefined = undefined,
  TOutput extends BaseType | undefined = undefined,
  TStream extends true | undefined = undefined,
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
            ? InputType<t.infer.decodeRaw.output<TInput>>
            : never,
          TStream extends true
            ? AsyncIterable<
                TOutput extends BaseType
                  ? t.infer.encode.input<TOutput>
                  : Return
              >
            : TOutput extends BaseType
              ? t.infer.encode.input<TOutput>
              : Return,
          Deps
        >
      }
    | ProcedureHandlerType<
        TInput extends BaseType
          ? InputType<t.infer.decodeRaw.output<TInput>>
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
    TStream extends true ? true : undefined
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

  // @ts-expect-error
  return createContractProcedure(
    c.procedure({ input, output, stream, timeout }),
    { dependencies, handler: handler as any, guards, middlewares, metadata },
  )
}

export const isProcedure = (value: any): value is AnyProcedure =>
  Boolean(value?.[kProcedure])
