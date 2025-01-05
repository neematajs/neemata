import type { TServiceContract, TSubscriptionContract } from '@nmtjs/contract'
import type { NeverType, t } from '@nmtjs/type'
import { Client, type ClientOptions } from './client.ts'
import type { Subscription } from './subscription.ts'
import type { ClientCallOptions, InputType, OutputType } from './types.ts'

type ClientServices = Record<string, TServiceContract>

type ClientServicesResolved<Services extends ClientServices> = {
  [K in keyof Services]: {
    [P in keyof Services[K]['procedures']]: {
      contract: Services[K]['procedures'][P]
      input: t.infer.input.encoded<Services[K]['procedures'][P]['input']>
      output: OutputType<
        t.infer.encoded<Services[K]['procedures'][P]['output']>
      >
      events: Services[K]['procedures'][P] extends TSubscriptionContract
        ? {
            [KE in keyof Services[K]['procedures'][P]['events']]: {
              payload: OutputType<
                t.infer.encoded<
                  Services[K]['procedures'][P]['events'][KE]['payload']
                >
              >
            }
          }
        : {}
    }
  }
}

type ClientCallers<
  Services extends ClientServicesResolved<Record<string, TServiceContract>>,
> = {
  [K in keyof Services]: {
    [P in keyof Services[K]]: (
      ...args: Services[K][P]['input'] extends never
        ? [options?: ClientCallOptions]
        : Services[K][P]['input'] extends undefined
          ? [data?: Services[K][P]['input'], options?: ClientCallOptions]
          : [data: Services[K][P]['input'], options?: ClientCallOptions]
    ) => Promise<
      Services[K][P]['contract'] extends TSubscriptionContract
        ? {
            payload: Services[K][P]['output'] extends never
              ? undefined
              : Services[K][P]['output']
            subscription: Subscription<{
              [KE in keyof Services[K][P]['events']]: [
                Services[K][P]['events'][KE],
              ]
            }>
          }
        : Services[K][P]['output'] extends never
          ? void
          : Services[K][P]['output']
    >
  }
}

export class StaticClient<Services extends ClientServices> extends Client {
  $types!: ClientServicesResolved<Services>
  #callers: ClientCallers<this['$types']>

  constructor(
    services: { [K in keyof Services]: Services[K]['name'] },
    options: ClientOptions,
  ) {
    super(options, Object.values(services))

    const callers = {} as any

    for (const [serviceKey, serviceName] of Object.entries(services)) {
      callers[serviceKey] = new Proxy(Object(), {
        get: (target, prop, receiver) => {
          // `await client.call.serviceName` or `await client.call.serviceName.procedureName`
          // without explicitly calling a function implicitly calls .then() on target
          // FIXME: this basically makes "then" a reserved word
          if (prop === 'then') return target
          return this.createCaller(serviceName, prop as string)
        },
      })
    }

    this.#callers = callers
  }

  get call() {
    return this.#callers
  }
}
