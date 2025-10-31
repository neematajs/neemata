import type { CallTypeProvider, OneOf, TypeProvider } from '@nmtjs/common'
import type {
  TAnyAPIContract,
  TAnyProcedureContract,
  TAnyRouterContract,
} from '@nmtjs/contract'
import type { ProtocolBlobInterface } from '@nmtjs/protocol'
import type {
  ProtocolBaseClientCallOptions,
  ProtocolError,
  ProtocolServerBlobStream,
  ProtocolServerStreamInterface,
} from '@nmtjs/protocol/client'
import type { BaseTypeAny, t } from '@nmtjs/type'
import type { PlainType } from '@nmtjs/type/_plain'

export type ClientOutputType<T> = T extends ProtocolBlobInterface
  ? ProtocolServerBlobStream
  : T extends { [PlainType]?: true }
    ? { [K in keyof Omit<T, PlainType>]: ClientOutputType<T[K]> }
    : T

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
    ? ClientOutputType<t.infer.encodeRaw.output<this['input']>>
    : never
}

export interface RuntimeOutputContractTypeProvider extends TypeProvider {
  output: this['input'] extends BaseTypeAny
    ? ClientOutputType<t.infer.decodeRaw.output<this['input']>>
    : never
}

export type AnyResolvedAPIContractProcedure = {
  contract: TAnyProcedureContract
  input: any
  output: any
}

export type AnyResolvedAPIContractRouter = {
  contract: TAnyRouterContract
  routes: Record<
    string,
    AnyResolvedAPIContractRouter | AnyResolvedAPIContractProcedure
  >
}

export type AnyResolvedAPIContract = Record<
  string,
  Record<string, AnyResolvedAPIContractProcedure | AnyResolvedAPIContractRouter>
>

export type ResolveAPIRouterRoutes<
  T extends TAnyRouterContract,
  InputTypeProvider extends TypeProvider = TypeProvider,
  OutputTypeProvider extends TypeProvider = TypeProvider,
> = {
  [K in keyof T['routes']]: T['routes'][K] extends TAnyRouterContract
    ? {
        contract: T['routes'][K]
        routes: ResolveAPIRouterRoutes<
          T['routes'][K],
          InputTypeProvider,
          OutputTypeProvider
        >
      }
    : T['routes'][K] extends TAnyProcedureContract
      ? {
          contract: T['routes'][K]
          input: CallTypeProvider<InputTypeProvider, T['routes'][K]['input']>

          output: T['routes'][K]['stream'] extends undefined | t.NeverType
            ? CallTypeProvider<OutputTypeProvider, T['routes'][K]['output']>
            : {
                result: CallTypeProvider<
                  OutputTypeProvider,
                  T['routes'][K]['output']
                >

                stream: ProtocolServerStreamInterface<
                  CallTypeProvider<OutputTypeProvider, T['routes'][K]['stream']>
                >
              }
        }
      : never
}

export type ResolveAPIContract<
  C extends TAnyAPIContract = TAnyAPIContract,
  InputTypeProvider extends TypeProvider = TypeProvider,
  OutputTypeProvider extends TypeProvider = TypeProvider,
> = ResolveAPIRouterRoutes<C['router'], InputTypeProvider, OutputTypeProvider>

export type ClientCaller<
  Procedure extends AnyResolvedAPIContractProcedure,
  SafeCall extends boolean,
> = (
  ...args: Procedure['input'] extends t.NeverType
    ? [data?: undefined, options?: Partial<ProtocolBaseClientCallOptions>]
    : undefined extends t.infer.encode.input<Procedure['contract']['input']>
      ? [
          data?: Procedure['input'],
          options?: Partial<ProtocolBaseClientCallOptions>,
        ]
      : [
          data: Procedure['input'],
          options?: Partial<ProtocolBaseClientCallOptions>,
        ]
) => SafeCall extends true
  ? Promise<OneOf<[{ output: Procedure['output'] }, { error: ProtocolError }]>>
  : Promise<Procedure['output']>

export type ClientCallers<
  Resolved extends AnyResolvedAPIContractRouter,
  SafeCall extends boolean,
> = {
  [K in keyof Resolved['routes']]: Resolved['routes'][K] extends AnyResolvedAPIContractProcedure
    ? ClientCaller<Resolved['routes'][K], SafeCall>
    : Resolved['routes'][K] extends AnyResolvedAPIContractRouter
      ? ClientCallers<Resolved['routes'][K], SafeCall>
      : never
}
