import type {
  TEventContract,
  TServiceContract,
  TSubscriptionContract,
} from '@nmtjs/contract'
import { type BaseType, NeverType, type t } from '@nmtjs/type'
import { type Compiled, compile } from '@nmtjs/type/compiler'

import { Client, type ClientOptions } from './client.ts'
import type { Subscription } from './subscription.ts'
import type { ClientTransport } from './transport.ts'
import type { ClientCallOptions, InputType, OutputType } from './types.ts'

type CompiledContract<T extends TServiceContract = TServiceContract> = {
  compiled: Map<BaseType, Compiled>
  contract: T
}

type ClientServicesResolved<Services extends ClientServices> = {
  [K in keyof Services]: {
    [P in keyof Services[K]['contract']['procedures']]: {
      contract: Services[K]['contract']['procedures'][P]
      input: InputType<
        t.infer.decoded<Services[K]['contract']['procedures'][P]['input']>
      >
      output: OutputType<
        t.infer.decoded<Services[K]['contract']['procedures'][P]['output']>
      >
      events: Services[K]['contract']['procedures'][P] extends TSubscriptionContract
        ? {
            [KE in keyof Services[K]['contract']['procedures'][P]['events']]: {
              payload: OutputType<
                t.infer.decoded<
                  Services[K]['contract']['procedures'][P]['events'][KE]['payload']
                >
              >
            }
          }
        : {}
    }
  }
}

type ClientServices = Record<string, CompiledContract>

type ClientCallers<Services extends ClientServicesResolved<ClientServices>> = {
  [K in keyof Services]: {
    [P in keyof Services[K]]: (
      ...args: Services[K][P]['input'] extends NeverType
        ? [options?: ClientCallOptions]
        : t.infer.input.decoded<
              Services[K][P]['contract']['input']
            > extends undefined
          ? [data?: Services[K][P]['input'], options?: ClientCallOptions]
          : [data: Services[K][P]['input'], options?: ClientCallOptions]
    ) => Promise<
      Services[K][P] extends TSubscriptionContract
        ? {
            payload: Services[K][P]['output'] extends never
              ? undefined
              : t.infer.decoded<Services[K][P]['output']>
            subscription: Subscription<{
              [KE in keyof Services[K][P]['events']]: [
                t.infer.decoded<Services[K][P]['events'][KE]['payload']>,
              ]
            }>
          }
        : Services[K][P]['output'] extends never
          ? void
          : Services[K][P]['output']
    >
  }
}

export class RuntimeClient<Services extends ClientServices> extends Client {
  $types!: ClientServicesResolved<Services>
  #callers: ClientCallers<this['$types']>

  constructor(
    protected readonly contracts: Services,
    options: ClientOptions,
  ) {
    super(
      options,
      Object.values(contracts).map((s) => s.contract.name),
    )

    const callers = {} as any
    for (const [serviceKey, service] of Object.entries(contracts)) {
      service.contract.procedures

      callers[serviceKey] = {} as any

      for (const procedureName in service.contract.procedures) {
        const { input, output } = service.contract.procedures[procedureName]

        function decodeOutput(data) {
          if (output instanceof NeverType) return undefined
          const compiled = service.compiled.get(output)!
          const result = compiled.decodeSafe(data)
          if (result.success) {
            return result.value
          } else {
            console.dir(result.error)
            throw new Error('Failed to decode output', {
              cause: result.error,
            })
          }
        }

        callers[serviceKey][procedureName] = this.createCaller(
          service.contract.name,
          procedureName,
          {
            timeout: service.contract.timeout,
            transformInput: (data: any) => {
              if (input instanceof NeverType) return undefined
              const compiled = service.compiled.get(input)!
              const result = compiled.encodeSafe(data)
              if (result.success) {
                return result.value
              } else {
                console.dir(result.error)
                throw new Error('Failed to encode input', {
                  cause: result.error,
                })
              }
            },
            transformOutput: (data: any) => {
              if (
                service.contract.procedures[procedureName].type ===
                'neemata:subscription'
              ) {
                data.payload = decodeOutput(data.payload)
                return data
              } else {
                return decodeOutput(data)
              }
            },
          },
        )
      }
    }
    this.#callers = callers
  }

  get call() {
    return this.#callers
  }

  protected checkTransport(transport: ClientTransport): void {
    for (const { contract } of Object.values(this.contracts)) {
      if (!contract.transports[transport.type])
        throw new Error(
          `Transport [${transport.type}] not supported for service [${contract.name}]`,
        )
    }
  }
}

export const compileContract = <T extends TServiceContract>(
  contract: T,
): CompiledContract<T> => {
  const compiled = new Map<BaseType, Compiled>()

  for (const procedure of Object.values(contract.procedures)) {
    const { input, output } = procedure
    if (procedure.type === 'neemata:subscription') {
      const { events } = procedure as TSubscriptionContract
      for (const event of Object.values(events) as TEventContract[]) {
        compiled.set(event.payload, compile(event.payload))
      }
    }
    compiled.set(input, compile(input))
    compiled.set(output, compile(output))
  }
  for (const event of Object.values(contract.events)) {
    compiled.set(event.payload, compile(event.payload))
  }

  return {
    compiled,
    contract,
  }
}
