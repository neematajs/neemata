import type {
  Encoded,
  TServiceContract,
  TSubscriptionContract,
} from '@nmtjs/contract'
import { Client, type ClientOptions } from './client.ts'
import type { Subscription } from './subscription.ts'
import type { ClientCallOptions, InputType, OutputType } from './types.ts'

type ClientServices = Record<string, TServiceContract>

type ClientCallers<Services extends ClientServices> = {
  [K in keyof Services]: {
    [P in keyof Services[K]['procedures']]: (
      ...args: Encoded<Services[K]['procedures'][P]['input']> extends never
        ? [options?: ClientCallOptions]
        : [
            data: InputType<Encoded<Services[K]['procedures'][P]['input']>>,
            options?: ClientCallOptions,
          ]
    ) => Promise<
      Services[K]['procedures'][P] extends TSubscriptionContract
        ? {
            payload: Encoded<
              Services[K]['procedures'][P]['output']
            > extends never
              ? undefined
              : Encoded<Services[K]['procedures'][P]['output']>
            subscription: Subscription<Services[K]['procedures'][P]>
          }
        : Encoded<Services[K]['procedures'][P]['static']> extends never
          ? void
          : OutputType<Encoded<Services[K]['procedures'][P]['output']>>
    >
  }
}

export class StaticClient<Services extends ClientServices> extends Client {
  #callers: ClientCallers<Services>

  constructor(
    services: { [K in keyof Services]: Services[K]['name'] },
    options: ClientOptions,
  ) {
    super(options, Object.values(services))

    const callers = {} as any

    for (const [serviceKey, serviceName] of Object.entries(services)) {
      callers[serviceKey] = new Proxy(Object(), {
        get: (target, prop, receiver) => {
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
