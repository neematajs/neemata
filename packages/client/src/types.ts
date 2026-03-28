import type { CallTypeProvider, OneOf, TypeProvider } from '@nmtjs/common'
import type { TAnyProcedureContract, TAnyRouterContract } from '@nmtjs/contract'
import type { ProtocolError } from '@nmtjs/protocol/client'
import type { BaseTypeAny, t } from '@nmtjs/type'

export const ResolvedType: unique symbol = Symbol('ResolvedType')
export type ResolvedType = typeof ResolvedType

export type RpcCallOptions = { timeout?: number; signal?: AbortSignal }

export type StreamCallOptions = RpcCallOptions & { autoReconnect?: boolean }

export type ClientCallOptions = StreamCallOptions & {
  /**
   * @internal
   */
  _stream_response?: boolean
}

export type BlobSubscriptionOptions = { signal?: AbortSignal }

export type StreamSubscriptionOptions = Partial<StreamCallOptions>

export interface StaticInputContractTypeProvider extends TypeProvider {
  output: this['input'] extends BaseTypeAny
    ? t.infer.decode.input<this['input']>
    : never
}

export interface RuntimeInputContractTypeProvider extends TypeProvider {
  output: this['input'] extends BaseTypeAny
    ? t.infer.encode.input<this['input']>
    : never
}

export interface StaticOutputContractTypeProvider extends TypeProvider {
  output: this['input'] extends BaseTypeAny
    ? t.infer.encode.output<this['input']>
    : never
}

export interface RuntimeOutputContractTypeProvider extends TypeProvider {
  output: this['input'] extends BaseTypeAny
    ? t.infer.decode.output<this['input']>
    : never
}

export type AnyResolvedContractProcedure = {
  [ResolvedType]: 'procedure'
  contract: TAnyProcedureContract
  stream: boolean
  input: any
  output: any
}

export type AnyResolvedContractRouter = {
  [ResolvedType]: 'router'
  [key: string]: AnyResolvedContractProcedure | AnyResolvedContractRouter
}

export type ResolveAPIRouterRoutes<
  T extends TAnyRouterContract,
  InputTypeProvider extends TypeProvider = TypeProvider,
  OutputTypeProvider extends TypeProvider = TypeProvider,
> = { [ResolvedType]: 'router' } & {
  [K in keyof T['routes']]: T['routes'][K] extends TAnyProcedureContract
    ? {
        [ResolvedType]: 'procedure'
        contract: T['routes'][K]
        stream: T['routes'][K]['stream'] extends true ? true : false
        input: CallTypeProvider<InputTypeProvider, T['routes'][K]['input']>
        output: T['routes'][K]['stream'] extends true
          ? AsyncIterable<
              CallTypeProvider<OutputTypeProvider, T['routes'][K]['output']>
            >
          : CallTypeProvider<OutputTypeProvider, T['routes'][K]['output']>
      }
    : T['routes'][K] extends TAnyRouterContract
      ? ResolveAPIRouterRoutes<
          T['routes'][K],
          InputTypeProvider,
          OutputTypeProvider
        >
      : never
}

export type ResolveContract<
  C extends TAnyRouterContract = TAnyRouterContract,
  InputTypeProvider extends TypeProvider = TypeProvider,
  OutputTypeProvider extends TypeProvider = TypeProvider,
> = ResolveAPIRouterRoutes<C, InputTypeProvider, OutputTypeProvider>

export type ClientCaller<
  Procedure extends AnyResolvedContractProcedure,
  SafeCall extends boolean,
> = (
  ...args: Procedure['input'] extends t.NeverType
    ? [
        data?: undefined,
        options?: Partial<
          Procedure['stream'] extends true ? StreamCallOptions : RpcCallOptions
        >,
      ]
    : undefined extends t.infer.encode.input<Procedure['contract']['input']>
      ? [
          data?: Procedure['input'],
          options?: Partial<
            Procedure['stream'] extends true
              ? StreamCallOptions
              : RpcCallOptions
          >,
        ]
      : [
          data: Procedure['input'],
          options?: Partial<
            Procedure['stream'] extends true
              ? StreamCallOptions
              : RpcCallOptions
          >,
        ]
) => SafeCall extends true
  ? Promise<OneOf<[{ result: Procedure['output'] }, { error: ProtocolError }]>>
  : Promise<Procedure['output']>

type OmitType<T extends object, E> = {
  [K in keyof T as T[K] extends E ? never : K]: T[K]
}

export type ClientCallers<
  Resolved extends AnyResolvedContractRouter,
  SafeCall extends boolean,
  Stream extends boolean,
> = OmitType<
  {
    [K in keyof Resolved]: Resolved[K] extends AnyResolvedContractProcedure
      ? Stream extends (Resolved[K]['stream'] extends true ? true : false)
        ? ClientCaller<Resolved[K], SafeCall>
        : never
      : Resolved[K] extends AnyResolvedContractRouter
        ? ClientCallers<Resolved[K], SafeCall, Stream>
        : never
  },
  never
>
