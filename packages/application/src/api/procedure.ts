import type { Schema, WireSchema } from '@nmtjs/common/schema'
import type { TAnyProcedureContract, TProcedureContract } from '@nmtjs/contract'
import type { Dependant, Dependencies, HandlerFn } from '@nmtjs/core'
import { c } from '@nmtjs/contract'
import { assertUniqueMetaBindings } from '@nmtjs/core'

import type { AnyGuard } from './guards.ts'
import type { AnyCompatibleMetaBinding, CompatibleMetaBinding } from './meta.ts'
import type { AnyMiddleware } from './middlewares.ts'
import { kProcedure } from './constants.ts'

// Inferred outputs are already wire values; transformations require an explicit schema.
const passthroughOutputSchema: Schema = Object.freeze({
  '~standard': Object.freeze({
    version: 1,
    vendor: 'neemata-passthrough',
    validate: (value) => ({ value }),
  }),
})

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
  ProcedureContract extends TAnyProcedureContract,
> = ProcedureDecodedInput<ProcedureContract['input']>

export type ProcedureEncodedOutput<
  Output extends WireSchema.Encode | WireSchema.Codec | undefined,
> = Output extends WireSchema.Encode | WireSchema.Codec
  ? WireSchema.EncodeInput<Output>
  : undefined

export interface BaseProcedure<
  ProcedureContract extends TAnyProcedureContract,
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
  ProcedureContract extends TAnyProcedureContract,
  ProcedureDeps extends Dependencies,
> extends BaseProcedure<ProcedureContract, ProcedureDeps> {
  handler: ProcedureHandlerType<
    ProcedureContractDecodedInput<ProcedureContract>,
    ProcedureContract['stream'] extends true
      ? AsyncIterable<ProcedureEncodedOutput<ProcedureContract['output']>>
      : ProcedureEncodedOutput<ProcedureContract['output']>,
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
      meta?: ProcedureMetaBinding<
        ProcedureContractDecodedInput<ProcedureContract>
      >[]
      streamTimeout?: number
      handler: ProcedureHandlerType<
        ProcedureContractDecodedInput<ProcedureContract>,
        ProcedureContract['stream'] extends undefined
          ? ProcedureEncodedOutput<ProcedureContract['output']>
          : AsyncIterable<ProcedureEncodedOutput<ProcedureContract['output']>>,
        ProcedureDeps
      >
    }
  | ProcedureHandlerType<
      ProcedureContractDecodedInput<ProcedureContract>,
      ProcedureContract['stream'] extends undefined
        ? ProcedureEncodedOutput<ProcedureContract['output']>
        : AsyncIterable<ProcedureEncodedOutput<ProcedureContract['output']>>,
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
  TInput extends WireSchema.Decode | WireSchema.Codec | undefined = undefined,
  TOutput extends WireSchema.Encode | WireSchema.Codec | undefined = undefined,
  TStream extends true | number | undefined = undefined,
  Deps extends Dependencies = {},
>(
  paramsOrHandler:
    | {
        input?: TInput
        output?: TOutput
        /**
         * Whether the procedure is a stream procedure.
         * If set to `true`, the procedure handler should return an `AsyncIterable` of output items.
         * If set to a number, it specifies an explicit stream timeout in milliseconds.
         */
        stream?: TStream
        dependencies?: Deps
        guards?: AnyGuard[]
        middlewares?: AnyMiddleware[]
        meta?: ProcedureMetaBinding<ProcedureDecodedInput<TInput>>[]
        timeout?: number
        handler: ProcedureHandlerType<
          ProcedureDecodedInput<TInput>,
          TStream extends true | number
            ? AsyncIterable<
                TOutput extends WireSchema.Encode | WireSchema.Codec
                  ? WireSchema.EncodeInput<TOutput>
                  : Return
              >
            : TOutput extends WireSchema.Encode | WireSchema.Codec
              ? WireSchema.EncodeInput<TOutput>
              : Return,
          Deps
        >
      }
    | ProcedureHandlerType<ProcedureDecodedInput<TInput>, Return, Deps>,
): Procedure<
  TProcedureContract<
    TInput,
    TOutput extends undefined ? WireSchema.Encode<Return> : TOutput,
    TStream extends true | number ? true : undefined
  >,
  Deps
> {
  const {
    input = undefined as any,
    output = passthroughOutputSchema as WireSchema.Encode<Return>,
    stream = undefined as any,
    dependencies = {} as Deps,
    guards = [],
    middlewares = [],
    meta = [],
    handler,
    timeout,
  } = typeof paramsOrHandler === 'function'
    ? { handler: paramsOrHandler }
    : paramsOrHandler

  // @ts-expect-error
  return createContractProcedure(
    c.procedure({ input, output, stream, timeout }),
    {
      dependencies,
      handler: handler as any,
      guards,
      middlewares,
      meta,
      streamTimeout: typeof stream === 'number' ? stream : undefined,
    },
  )
}

export const isProcedure = (value: any): value is AnyProcedure =>
  Boolean(value?.[kProcedure])
