import type { CallTypeProvider, TypeProvider } from '@nmtjs/common'
import type { TAnyAPIContract } from '@nmtjs/contract'
import type { ProtocolServerStream } from '@nmtjs/protocol/client'
import type { InputType, OutputType } from '@nmtjs/protocol/common'
import type { BaseTypeAny, NeverType, t } from '@nmtjs/type'

export interface StaticContractTypeProvider extends TypeProvider {
  output: this['input'] extends BaseTypeAny
    ? t.infer.input.decoded<this['input']>
    : never
}

export interface RuntimeContractTypeProvider extends TypeProvider {
  output: this['input'] extends BaseTypeAny
    ? t.infer.decoded<this['input']>
    : never
}

export type ResolveAPIContract<
  C extends TAnyAPIContract = TAnyAPIContract,
  T extends TypeProvider = TypeProvider,
> = {
  [N in keyof C['namespaces'] as C['namespaces'][N]['name']]: {
    procedures: {
      [P in keyof C['namespaces'][N]['procedures'] as C['namespaces'][N]['procedures'][P]['name']]: {
        contract: C['namespaces'][N]['procedures'][P]
        input: InputType<
          CallTypeProvider<T, C['namespaces'][N]['procedures'][P]['input']>
        >
        output: C['namespaces'][N]['procedures'][P]['stream'] extends NeverType
          ? OutputType<
              CallTypeProvider<T, C['namespaces'][N]['procedures'][P]['output']>
            >
          : [
              result: OutputType<
                CallTypeProvider<
                  T,
                  C['namespaces'][N]['procedures'][P]['output']
                >
              >,
              stream: ProtocolServerStream<
                CallTypeProvider<
                  T,
                  C['namespaces'][N]['procedures'][P]['stream']
                >
              >,
            ]
      }
    }
    events: {
      [KE in keyof C['namespaces'][N]['events'] as C['namespaces'][N]['events'][KE]['name']]: {
        payload: OutputType<
          CallTypeProvider<T, C['namespaces'][N]['events'][KE]['payload']>
        >
      }
    }
  }
}

export type ResolveClientEvents<
  C extends ResolveAPIContract = ResolveAPIContract,
> = {
  [N in keyof C]: {
    [KE in keyof C[N]['events']]: C[N]['events'][KE]['payload']
  }
}

export type ClientCallOptions = {
  signal?: AbortSignal
}

export type ClientCallers<Resolved extends ResolveAPIContract> = {
  [N in keyof Resolved]: {
    [P in keyof Resolved[N]['procedures']]: (
      ...args: Resolved[N]['procedures'][P]['input'] extends NeverType
        ? [options?: ClientCallOptions]
        : t.infer.input.encoded<
              Resolved[N]['procedures'][P]['contract']['input']
            > extends undefined
          ? [
              data?: Resolved[N]['procedures'][P]['input'],
              options?: ClientCallOptions,
            ]
          : [
              data: Resolved[N]['procedures'][P]['input'],
              options?: ClientCallOptions,
            ]
    ) => Promise<Resolved[N]['procedures'][P]['output']>
  }
}
