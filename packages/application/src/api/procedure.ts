import type {
  TAnyCallableContract,
  TAnyProcedureContract,
  TAnyStreamContract,
  TProcedureContract,
  TStreamContract,
} from '@nmtjs/contract'
import type { Dependant, Dependencies, HandlerFn } from '@nmtjs/core'
import type { BaseType } from '@nmtjs/type'
import type * as zod from 'zod/mini'
import { c } from '@nmtjs/contract'
import { assertUniqueMetaBindings } from '@nmtjs/core'
import { t } from '@nmtjs/type'

import type { AnyGuard } from './guards.ts'
import type { JsonPrimitive } from './json-primitive.ts'
import type { AnyCompatibleMetaBinding, CompatibleMetaBinding } from './meta.ts'
import type { AnyMiddleware } from './middlewares.ts'
import { kProcedure } from './constants.ts'

export type ProcedureMetaBinding<Input> = CompatibleMetaBinding<Input>
export type AnyProcedureMetaBinding = AnyCompatibleMetaBinding

export type ProcedureDecodedInput<Input extends BaseType | undefined> =
  Input extends BaseType ? t.infer.decode.output<Input> : never

export type ProcedureContractDecodedInput<
  ProcedureContract extends TAnyCallableContract,
> = t.infer.decode.output<ProcedureContract['input']>

export interface BaseProcedure<
  ProcedureContract extends TAnyCallableContract,
  ProcedureDeps extends Dependencies,
> extends Dependant<ProcedureDeps> {
  contract: ProcedureContract
  handler: (...args: any[]) => any
  meta: readonly AnyProcedureMetaBinding[]
  dependencies: ProcedureDeps
  guards: Set<AnyGuard>
  middlewares: Set<AnyMiddleware>
  streamTimeout?: number
  [kProcedure]: true
}

export type ProcedureHandlerType<
  Input,
  Output,
  Deps extends Dependencies,
> = HandlerFn<Deps, [data: Input], Output>

export interface Procedure<
  ProcedureContract extends TAnyCallableContract,
  ProcedureDeps extends Dependencies,
> extends BaseProcedure<ProcedureContract, ProcedureDeps> {
  handler: ProcedureHandlerType<
    ProcedureContractDecodedInput<ProcedureContract>,
    ProcedureContract extends TAnyStreamContract
      ? AsyncIterable<t.infer.encode.input<ProcedureContract['output']>>
      : t.infer.encode.input<ProcedureContract['output']>,
    ProcedureDeps
  >
}

export type AnyProcedure<
  Contract extends TAnyCallableContract = TAnyCallableContract,
> = BaseProcedure<Contract, Dependencies>

type CallableParams<
  Contract extends TAnyCallableContract,
  Deps extends Dependencies,
  Output,
  Extra = {},
> =
  | ({
      dependencies?: Deps
      guards?: AnyGuard[]
      middlewares?: AnyMiddleware[]
      meta?: ProcedureMetaBinding<ProcedureContractDecodedInput<Contract>>[]
      handler: ProcedureHandlerType<
        ProcedureContractDecodedInput<Contract>,
        Output,
        Deps
      >
    } & Extra)
  | ProcedureHandlerType<ProcedureContractDecodedInput<Contract>, Output, Deps>

export type CreateProcedureParams<
  ProcedureContract extends TAnyProcedureContract,
  ProcedureDeps extends Dependencies,
> = CallableParams<
  ProcedureContract,
  ProcedureDeps,
  t.infer.encode.input<ProcedureContract['output']>
>

export type CreateStreamParams<
  StreamContract extends TAnyStreamContract,
  StreamDeps extends Dependencies,
> = CallableParams<
  StreamContract,
  StreamDeps,
  AsyncIterable<t.infer.encode.input<StreamContract['output']>>,
  { streamTimeout?: number }
>

type AnyCallableParams =
  | {
      dependencies?: Dependencies
      guards?: AnyGuard[]
      middlewares?: AnyMiddleware[]
      meta?: AnyProcedureMetaBinding[]
      streamTimeout?: number
      handler: (...args: any[]) => any
    }
  | ((...args: any[]) => any)

function createCallable(
  contract: TAnyCallableContract,
  paramsOrHandler: AnyCallableParams,
) {
  const { handler, ...params } =
    typeof paramsOrHandler === 'function'
      ? { handler: paramsOrHandler }
      : paramsOrHandler

  const dependencies = params.dependencies ?? {}
  const middlewares = new Set(params.middlewares ?? [])
  const guards = new Set(params.guards ?? [])
  const meta = Object.freeze([...(params.meta ?? [])])
  const { streamTimeout } = params

  if (streamTimeout !== undefined && streamTimeout <= 0) {
    throw new Error('Stream timeout must be a positive integer')
  }

  assertUniqueMetaBindings(meta, 'procedure config')

  return {
    contract,
    dependencies,
    middlewares,
    guards,
    meta,
    streamTimeout,
    handler,
    [kProcedure]: true,
  }
}

/**
 * Splits the contract-less procedure/stream options into the contract input
 * and the implementation params; each caller picks its own contract kind.
 */
function splitOptions(
  options: CreateCallableOptions<any, any, any, any> & {
    streamTimeout?: number
  },
) {
  const {
    input = t.never() as any,
    output = t.any() as any,
    dependencies = {},
    guards = [],
    middlewares = [],
    meta = [],
    handler,
    timeout,
    title,
    description,
    streamTimeout,
  } = options

  const contract = {
    input,
    output,
    timeout,
    schemaOptions: { title, description },
  }
  const params = {
    dependencies,
    handler,
    guards,
    middlewares,
    meta,
    streamTimeout,
  }

  return { contract, params }
}

interface CreateCallableOptions<
  TInput extends BaseType | undefined,
  TOutput extends BaseType | undefined,
  Deps extends Dependencies,
  Output,
> {
  input?: TInput
  output?: TOutput
  dependencies?: Deps
  guards?: AnyGuard[]
  middlewares?: AnyMiddleware[]
  meta?: ProcedureMetaBinding<ProcedureDecodedInput<TInput>>[]
  timeout?: number
  /** Short human-readable name, used for generated API documentation. */
  title?: string
  /** Human-readable description, used for generated API documentation. */
  description?: string
  handler: ProcedureHandlerType<ProcedureDecodedInput<TInput>, Output, Deps>
}

type CallableOutputType<
  TOutput extends BaseType | undefined,
  Return,
> = TOutput extends BaseType ? t.infer.encode.input<TOutput> : Return

type SynthesizedOutput<
  TOutput extends BaseType | undefined,
  Return,
> = TOutput extends undefined
  ? t.CustomType<
      JsonPrimitive<Return>,
      zod.ZodMiniCustom<JsonPrimitive<Return>, JsonPrimitive<Return>>
    >
  : TOutput

export function createProcedure<
  Return,
  TInput extends BaseType | undefined = undefined,
  TOutput extends BaseType | undefined = undefined,
  Deps extends Dependencies = {},
>(
  paramsOrHandler:
    | CreateCallableOptions<
        TInput,
        TOutput,
        Deps,
        CallableOutputType<TOutput, Return>
      >
    | ProcedureHandlerType<ProcedureDecodedInput<TInput>, Return, Deps>,
): Procedure<
  TProcedureContract<
    TInput extends undefined ? t.NeverType : TInput,
    SynthesizedOutput<TOutput, Return>
  >,
  Deps
> {
  const options =
    typeof paramsOrHandler === 'function'
      ? { handler: paramsOrHandler }
      : paramsOrHandler
  const { contract, params } = splitOptions(options)

  return createCallable(c.procedure(contract), params) as any
}

export function createContractProcedure<
  ProcedureContract extends TAnyProcedureContract,
  ProcedureDeps extends Dependencies,
>(
  contract: ProcedureContract,
  paramsOrHandler: CreateProcedureParams<ProcedureContract, ProcedureDeps>,
): Procedure<ProcedureContract, ProcedureDeps> {
  return createCallable(contract, paramsOrHandler) as any
}

export function createStream<
  Return,
  TInput extends BaseType | undefined = undefined,
  TOutput extends BaseType | undefined = undefined,
  Deps extends Dependencies = {},
>(
  params: CreateCallableOptions<
    TInput,
    TOutput,
    Deps,
    AsyncIterable<CallableOutputType<TOutput, Return>>
  > & {
    /** Explicit stream timeout in milliseconds. */
    streamTimeout?: number
  },
): Procedure<
  TStreamContract<
    TInput extends undefined ? t.NeverType : TInput,
    SynthesizedOutput<TOutput, Return>
  >,
  Deps
> {
  const { contract, params: streamParams } = splitOptions(params)

  return createCallable(c.stream(contract), streamParams) as any
}

export function createContractStream<
  StreamContract extends TAnyStreamContract,
  StreamDeps extends Dependencies,
>(
  contract: StreamContract,
  paramsOrHandler: CreateStreamParams<StreamContract, StreamDeps>,
): Procedure<StreamContract, StreamDeps> {
  return createCallable(contract, paramsOrHandler) as any
}

export const isProcedure = (value: any): value is AnyProcedure =>
  Boolean(value?.[kProcedure])
