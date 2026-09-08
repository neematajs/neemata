import type { Schema, WireSchema } from '@nmtjs/common/schema'
import type {
  TAnyCallableContract,
  TAnyProcedureContract,
  TAnyStreamContract,
  TProcedureContract,
  TStreamContract,
} from '@nmtjs/contract'
import type { Dependant, Dependencies, HandlerFn } from '@nmtjs/core'
import { noopSchema } from '@nmtjs/common/schema'
import { c } from '@nmtjs/contract'
import { assertUniqueMetaBindings } from '@nmtjs/core'

import type { AnyGuard } from './guards.ts'
import type { AnyCompatibleMetaBinding, CompatibleMetaBinding } from './meta.ts'
import type { AnyMiddleware } from './middlewares.ts'
import { kProcedure } from './constants.ts'

export type {
  AnyCompatibleMetaBinding,
  CompatibleMetaBinding,
  StaticOrBeforeDecodeMetaBinding,
} from './meta.ts'
export type ProcedureMetaBinding<Input> = CompatibleMetaBinding<Input>
export type AnyProcedureMetaBinding = AnyCompatibleMetaBinding

export type ProcedureDecodedInput<
  Input extends WireSchema.Decode | WireSchema.Codec | undefined,
> = Input extends WireSchema.Decode | WireSchema.Codec
  ? WireSchema.DecodeOutput<Input>
  : undefined

export type ProcedureContractDecodedInput<
  ProcedureContract extends TAnyCallableContract,
> = ProcedureDecodedInput<ProcedureContract['input']>

export type ProcedureEncodedOutput<
  Output extends WireSchema.Encode | WireSchema.Codec | undefined,
> = Output extends WireSchema.Encode | WireSchema.Codec
  ? WireSchema.EncodeInput<Output>
  : undefined

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
  [kProcedure]: any
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
      ? AsyncIterable<ProcedureEncodedOutput<ProcedureContract['output']>>
      : ProcedureEncodedOutput<ProcedureContract['output']>,
    ProcedureDeps
  >
}

export type AnyProcedure<
  Contract extends TAnyCallableContract = TAnyCallableContract,
> = BaseProcedure<Contract, Dependencies>

export type CreateProcedureParams<
  ProcedureContract extends TAnyProcedureContract,
  ProcedureDeps extends Dependencies,
> =
  | {
      dependencies?: ProcedureDeps
      guards?: AnyGuard[]
      middlewares?: AnyMiddleware[]
      meta?: ProcedureMetaBinding<
        ProcedureContractDecodedInput<ProcedureContract>
      >[]
      handler: ProcedureHandlerType<
        ProcedureContractDecodedInput<ProcedureContract>,
        ProcedureEncodedOutput<ProcedureContract['output']>,
        ProcedureDeps
      >
    }
  | ProcedureHandlerType<
      ProcedureContractDecodedInput<ProcedureContract>,
      ProcedureEncodedOutput<ProcedureContract['output']>,
      ProcedureDeps
    >

export type CreateStreamParams<
  StreamContract extends TAnyStreamContract,
  StreamDeps extends Dependencies,
> =
  | {
      dependencies?: StreamDeps
      guards?: AnyGuard[]
      middlewares?: AnyMiddleware[]
      meta?: ProcedureMetaBinding<
        ProcedureContractDecodedInput<StreamContract>
      >[]
      streamTimeout?: number
      handler: ProcedureHandlerType<
        ProcedureContractDecodedInput<StreamContract>,
        AsyncIterable<ProcedureEncodedOutput<StreamContract['output']>>,
        StreamDeps
      >
    }
  | ProcedureHandlerType<
      ProcedureContractDecodedInput<StreamContract>,
      AsyncIterable<ProcedureEncodedOutput<StreamContract['output']>>,
      StreamDeps
    >

export function _createBaseProcedure<
  ProcedureContract extends TAnyCallableContract,
  ProcedureDeps extends Dependencies,
>(
  contract: ProcedureContract,
  params: {
    dependencies?: ProcedureDeps
    middlewares?: AnyMiddleware[]
    guards?: AnyGuard[]
    meta?: AnyProcedureMetaBinding[]
    streamTimeout?: number
  },
) {
  const dependencies = params.dependencies ?? ({} as ProcedureDeps)
  const middlewares = new Set(params.middlewares ?? [])
  const guards = new Set(params.guards ?? [])
  const meta = Object.freeze([...(params.meta ?? [])])
  const streamTimeout = params.streamTimeout

  if (typeof streamTimeout !== 'undefined' && streamTimeout <= 0) {
    throw new Error('Stream timeout must be a positive integer')
  }

  assertUniqueMetaBindings(meta, 'procedure config')

  return { contract, dependencies, middlewares, guards, meta, streamTimeout }
}

interface CreateCallableOptions<
  TInput extends WireSchema.Decode | WireSchema.Codec | undefined,
  TOutput extends WireSchema.Encode | WireSchema.Codec | undefined,
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
  TOutput extends WireSchema.Encode | WireSchema.Codec | undefined,
  Return,
> = TOutput extends WireSchema.Encode | WireSchema.Codec
  ? WireSchema.EncodeInput<TOutput>
  : Return

type SynthesizedOutput<
  TOutput extends WireSchema.Encode | WireSchema.Codec | undefined,
  Return,
> = TOutput extends undefined ? Schema.WithJSONSchema<Return> : TOutput

export function createProcedure<
  Return,
  TInput extends WireSchema.Decode | WireSchema.Codec | undefined = undefined,
  TOutput extends WireSchema.Encode | WireSchema.Codec | undefined = undefined,
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
  TProcedureContract<TInput, SynthesizedOutput<TOutput, Return>>,
  Deps
> {
  const {
    input = undefined as any,
    output = noopSchema<Return>(),
    dependencies = {} as Deps,
    guards = [],
    middlewares = [],
    meta = [],
    handler,
    timeout,
    title,
    description,
  } = typeof paramsOrHandler === 'function'
    ? { handler: paramsOrHandler }
    : paramsOrHandler

  return createContractProcedure(
    c.procedure({
      input,
      output,
      timeout,
      schemaOptions: { title, description },
    }) as TProcedureContract<TInput, SynthesizedOutput<TOutput, Return>>,
    {
      dependencies,
      handler: handler as any,
      guards,
      middlewares,
      meta,
    },
  )
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

export function createStream<
  Return,
  TInput extends WireSchema.Decode | WireSchema.Codec | undefined = undefined,
  TOutput extends WireSchema.Encode | WireSchema.Codec | undefined = undefined,
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
  TStreamContract<TInput, SynthesizedOutput<TOutput, Return>>,
  Deps
> {
  const {
    input = undefined as any,
    output = noopSchema<Return>(),
    dependencies = {} as Deps,
    guards = [],
    middlewares = [],
    meta = [],
    handler,
    timeout,
    title,
    description,
    streamTimeout,
  } = params

  return createContractStream(
    c.stream({
      input,
      output,
      timeout,
      schemaOptions: { title, description },
    }) as TStreamContract<TInput, SynthesizedOutput<TOutput, Return>>,
    {
      dependencies,
      handler: handler as any,
      guards,
      middlewares,
      meta,
      streamTimeout,
    },
  )
}

export function createContractStream<
  StreamContract extends TAnyStreamContract,
  StreamDeps extends Dependencies,
>(
  contract: StreamContract,
  paramsOrHandler: CreateStreamParams<StreamContract, StreamDeps>,
): Procedure<StreamContract, StreamDeps> {
  const { handler, ...params } =
    typeof paramsOrHandler === 'function'
      ? { handler: paramsOrHandler }
      : paramsOrHandler

  return Object.assign(_createBaseProcedure(contract, params), {
    handler,
    [kProcedure]: true,
  }) as any
}

export const isProcedure = (value: any): value is AnyProcedure =>
  Boolean(value?.[kProcedure])
