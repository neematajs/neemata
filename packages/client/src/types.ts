import type { CallTypeProvider, OneOf, TypeProvider } from '@nmtjs/common'
import type { TAnyAPIContract } from '@nmtjs/contract'
import type {
  ProtocolBaseClientCallOptions,
  ProtocolError,
  ProtocolServerStreamInterface,
} from '@nmtjs/protocol/client'
import type { InputType, OutputType } from '@nmtjs/protocol/client'
import type { BaseTypeAny, NeverType, t } from '@nmtjs/type'

export interface StaticInputContractTypeProvider extends TypeProvider {
  output: this['input'] extends BaseTypeAny
    ? t.infer.encoded.input<this['input']>
    : never
}

export interface RuntimeInputContractTypeProvider extends TypeProvider {
  output: this['input'] extends BaseTypeAny
    ? t.infer.decoded.input<this['input']>
    : never
}

export interface StaticOutputContractTypeProvider extends TypeProvider {
  output: this['input'] extends BaseTypeAny
    ? t.infer.encoded.output<this['input']>
    : never
}

export interface RuntimeOutputContractTypeProvider extends TypeProvider {
  output: this['input'] extends BaseTypeAny
    ? t.infer.decoded.output<this['input']>
    : never
}

export type ResolveAPIContract<
  C extends TAnyAPIContract = TAnyAPIContract,
  InputTypeProvider extends TypeProvider = TypeProvider,
  OutputTypeProvider extends TypeProvider = TypeProvider,
> = {
  [N in keyof C['namespaces'] as C['namespaces'][N]['name']]: {
    procedures: {
      [P in keyof C['namespaces'][N]['procedures'] as C['namespaces'][N]['procedures'][P]['name']]: {
        contract: C['namespaces'][N]['procedures'][P]
        input: InputType<
          CallTypeProvider<
            InputTypeProvider,
            C['namespaces'][N]['procedures'][P]['input']
          >
        >
        output: C['namespaces'][N]['procedures'][P]['stream'] extends NeverType
          ? OutputType<
              CallTypeProvider<
                OutputTypeProvider,
                C['namespaces'][N]['procedures'][P]['output']
              >
            >
          : {
              result: OutputType<
                CallTypeProvider<
                  OutputTypeProvider,
                  C['namespaces'][N]['procedures'][P]['output']
                >
              >
              stream: ProtocolServerStreamInterface<
                CallTypeProvider<
                  OutputTypeProvider,
                  C['namespaces'][N]['procedures'][P]['stream']
                >
              >
            }
      }
    }
    events: {
      [KE in keyof C['namespaces'][N]['events'] as C['namespaces'][N]['events'][KE]['name']]: {
        payload: OutputType<
          CallTypeProvider<
            OutputTypeProvider,
            C['namespaces'][N]['events'][KE]['payload']
          >
        >
      }
    }
  }
}

export type ResolveClientEvents<
  C extends ResolveAPIContract = ResolveAPIContract,
> = {
  [N in keyof C]: {
    [KE in keyof C[N]['events'] as `${Extract<N, string>}/${Extract<KE, string>}`]: [
      C[N]['events'][KE]['payload'],
    ]
  }
}[keyof C]

export type ClientCallers<
  Resolved extends ResolveAPIContract,
  SafeCall extends boolean,
> = {
  [N in keyof Resolved]: {
    [P in keyof Resolved[N]['procedures']]: (
      ...args: Resolved[N]['procedures'][P]['input'] extends NeverType
        ? [data?: undefined, options?: Partial<ProtocolBaseClientCallOptions>]
        : undefined extends t.infer.encoded.input<
              Resolved[N]['procedures'][P]['contract']['input']
            >
          ? [
              data?: Resolved[N]['procedures'][P]['input'],
              options?: Partial<ProtocolBaseClientCallOptions>,
            ]
          : [
              data: Resolved[N]['procedures'][P]['input'],
              options?: Partial<ProtocolBaseClientCallOptions>,
            ]
    ) => SafeCall extends true
      ? Promise<
          OneOf<
            [
              {
                error?: undefined
                output: Resolved[N]['procedures'][P]['output']
              },
              { error: ProtocolError; output?: undefined },
            ]
          >
        >
      : Promise<Resolved[N]['procedures'][P]['output']>
  }
}
