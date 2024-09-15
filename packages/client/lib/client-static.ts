import type { TServiceContract, TSubscriptionContract } from '@nmtjs/contract'
import type { NeverType, t } from '@nmtjs/type'
import { Client, type ClientOptions } from './client.ts'
import type { Subscription } from './subscription.ts'
import type { ClientCallOptions, InputType, OutputType } from './types.ts'

type ClientServices = Record<string, TServiceContract>

type ClientCallers<Services extends ClientServices> = {
  [K in keyof Services]: {
    [P in keyof Services[K]['procedures']]: (
      ...args: Services[K]['procedures'][P]['input'] extends NeverType
        ? [options?: ClientCallOptions]
        : t.infer.staticType<
              Services[K]['procedures'][P]['input']
            >['isOptional'] extends true
          ? [
              data?: InputType<
                t.infer.encoded<Services[K]['procedures'][P]['input']>
              >,
              options?: ClientCallOptions,
            ]
          : [
              data: InputType<
                t.infer.encoded<Services[K]['procedures'][P]['input']>
              >,
              options?: ClientCallOptions,
            ]
    ) => Promise<
      Services[K]['procedures'][P] extends TSubscriptionContract
        ? {
            payload: Services[K]['procedures'][P]['output'] extends NeverType
              ? undefined
              : t.infer.encoded<Services[K]['procedures'][P]['output']>
            subscription: Subscription<{
              [KE in keyof Services[K]['procedures'][P]['events']]: [
                t.infer.encoded<
                  Services[K]['procedures'][P]['events'][KE]['payload']
                >,
              ]
            }>
          }
        : Services[K]['procedures'][P]['output'] extends NeverType
          ? void
          : OutputType<t.infer.encoded<Services[K]['procedures'][P]['output']>>
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
