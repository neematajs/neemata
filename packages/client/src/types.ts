import type { CallTypeProvider, OneOf, TypeProvider } from '@nmtjs/common'
import type { TAnyAPIContract, TAnyProcedureContract } from '@nmtjs/contract'
import type {
  InputType,
  OutputType,
  ProtocolBaseClientCallOptions,
  ProtocolError,
  ProtocolServerStreamInterface,
} from '@nmtjs/protocol/client'
import type { BaseTypeAny, t } from '@nmtjs/type'

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

export type AnyResolvedAPIContract = Record<
  string,
  {
    procedures: Record<
      string,
      {
        contract: TAnyProcedureContract
        input: any
        output: any
      }
    >
    events: Record<
      string,
      {
        payload: any
      }
    >
  }
>

export type ResolveAPIContract<
  C extends TAnyAPIContract = TAnyAPIContract,
  InputTypeProvider extends TypeProvider = TypeProvider,
  OutputTypeProvider extends TypeProvider = TypeProvider,
> = {
  [N in keyof C['namespaces']]: {
    procedures: {
      [P in keyof C['namespaces'][N]['procedures']]: {
        contract: C['namespaces'][N]['procedures'][P]
        input: InputType<
          CallTypeProvider<
            InputTypeProvider,
            C['namespaces'][N]['procedures'][P]['input']
          >
        >
        output: C['namespaces'][N]['procedures'][P]['stream'] extends
          | undefined
          | t.NeverType
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
      [KE in keyof C['namespaces'][N]['events']]: {
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
  C extends AnyResolvedAPIContract = AnyResolvedAPIContract,
> = {
  [N in keyof C]: {
    [E in keyof C[N]['events'] as `${Extract<N, string>}/${Extract<E, string>}`]: [
      C[N]['events'][E]['payload'],
    ]
  }
}[keyof C]

export type ClientCallers<
  Resolved extends AnyResolvedAPIContract,
  SafeCall extends boolean,
> = {
  [N in keyof Resolved]: {
    [P in keyof Resolved[N]['procedures']]: (
      ...args: Resolved[N]['procedures'][P]['input'] extends t.NeverType
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
                output: Resolved[N]['procedures'][P]['output']
              },
              { error: ProtocolError },
            ]
          >
        >
      : Promise<Resolved[N]['procedures'][P]['output']>
  }
}
