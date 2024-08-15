import type {
  Decoded,
  TEventContract,
  TSchema,
  TServiceContract,
  TSubscriptionContract,
} from '@nmtjs/contract'
import { type Compiled, compile } from '@nmtjs/contract/compiler'
import { ContractGuard } from '@nmtjs/contract/guards'
import { Client, type ClientOptions } from './client.ts'
import type { Subscription } from './subscription.ts'
import type { ClientCallOptions, InputType, OutputType } from './types.ts'

type CompiledContract<T extends TServiceContract = TServiceContract> = {
  compiled: Map<TSchema, Compiled>
  contract: T
}

type ClientServices = Record<string, CompiledContract>

type ClientCallers<Services extends ClientServices> = {
  [K in keyof Services]: {
    [P in keyof Services[K]['contract']['procedures']]: (
      ...args: Decoded<
        Services[K]['contract']['procedures'][P]['input']
      > extends never
        ? [options?: ClientCallOptions]
        : [
            data: InputType<
              Decoded<Services[K]['contract']['procedures'][P]['input']>
            >,
            options?: ClientCallOptions,
          ]
    ) => Promise<
      Services[K]['contract']['procedures'][P] extends TSubscriptionContract
        ? {
            payload: Decoded<
              Services[K]['contract']['procedures'][P]['output']
            > extends never
              ? undefined
              : Decoded<Services[K]['contract']['procedures'][P]['output']>
            subscription: Subscription<Services[K]['contract']['procedures'][P]>
          }
        : Decoded<
              Services[K]['contract']['procedures'][P]['static']
            > extends never
          ? void
          : OutputType<
              Decoded<Services[K]['contract']['procedures'][P]['output']>
            >
    >
  }
}

export class RuntimeClient<Services extends ClientServices> extends Client {
  #callers: ClientCallers<Services>

  constructor(services: Services, options: ClientOptions) {
    super(
      options,
      Object.values(services).map((s) => s.contract.name),
    )

    const callers = {} as any
    for (const [serviceKey, serviceContract] of Object.entries(services)) {
      if (!serviceContract.contract.transports[this.transport.type])
        throw new Error(
          `Transport [${this.transport.type}] not supported for service [${serviceContract.contract.name}]`,
        )

      callers[serviceKey] = {} as any

      for (const procedureName in serviceContract.contract.procedures) {
        const { input, output } =
          serviceContract.contract.procedures[procedureName]

        callers[serviceKey][procedureName] = this.createCaller(
          serviceContract.contract.name,
          procedureName,
          {
            timeout: serviceContract.contract.timeout,
            transformInput: (data: any) => {
              if (ContractGuard.IsNever(data)) return undefined
              const compiled = serviceContract.compiled.get(input)!
              const result = compiled.encode(data)
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
              if (ContractGuard.IsNever(data)) return undefined
              const compiled = serviceContract.compiled.get(output)!
              const result = compiled.decode(data)
              if (result.success) {
                return result.value
              } else {
                console.dir(result.error)
                throw new Error('Failed to decode output', {
                  cause: result.error,
                })
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
}

export const compileContract = <T extends TServiceContract>(
  contract: T,
): CompiledContract<T> => {
  const compiled = new Map<TSchema, Compiled>()
  for (const procedureContract of Object.values(contract.procedures)) {
    const { input, output, events } = procedureContract
    if (ContractGuard.IsSubscription(procedureContract)) {
      for (const event of Object.values(events) as TEventContract[]) {
        compiled.set(event, compile(event))
      }
    }
    compiled.set(input, compile(input))
    compiled.set(output, compile(output))
  }
  for (const eventContract of Object.values(contract.events)) {
    compiled.set(eventContract, compile(eventContract))
  }

  return {
    compiled,
    contract,
  }
}
