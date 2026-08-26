import type { NeemRuntime } from '@nmtjs/neem'
import { createValueInjectable } from '@nmtjs/core'
import { defineRuntimeWorker } from '@nmtjs/neem'

import type { ApplicationTransport } from '../config.ts'
import type {
  AnyApplicationHostDefinition,
  ApplicationHost,
  ApplicationHostDefinition,
  ApplicationHostTransportConfig,
} from '../host.ts'
import type {
  NeemataRuntimeContext,
  NeemataRuntimeThreadOptions,
  NeemataRuntimeTransportOptions,
  NeemataWorker,
} from './types.ts'
import { createApplicationHost } from '../host.ts'

export type {
  NeemataRuntimeContext,
  NeemataRuntimeThreadOptions,
  NeemataRuntimeTransportOptions,
  NeemataWorker,
} from './types.ts'

export class NeemataApplicationRuntime<
  THost extends AnyApplicationHostDefinition = AnyApplicationHostDefinition,
> implements NeemRuntime {
  readonly host: ApplicationHost<THost['transports']>

  constructor(readonly ctx: NeemataRuntimeContext<THost>) {
    this.host = createApplicationHost(ctx.definition.application, {
      name: ctx.name,
      logger: ctx.logger,
      transports: createHostTransportConfig(
        ctx.definition.transports,
        ctx.data,
      ),
      identity: ctx.definition.identity,
    })
  }

  async start() {
    return this.host.start()
  }

  async stop() {
    return this.host.stop()
  }
}

export function defineNeemataWorker<
  const THost extends ApplicationHostDefinition,
>(host: THost): NeemataWorker<THost> {
  return defineRuntimeWorker<NeemataRuntimeThreadOptions<THost>, THost>({
    definition: host,
    createRuntime(ctx) {
      return new NeemataApplicationRuntime(ctx)
    },
    ...((import.meta as ImportMeta & { readonly hot?: unknown }).hot
      ? {
          async hmr() {
            const { createNeemataHmrAdapter } =
              await import('../internal/neem-hmr.ts')
            return createNeemataHmrAdapter<THost>()
          },
        }
      : {}),
  })
}

function createHostTransportConfig<
  Transports extends Record<string, ApplicationTransport>,
>(
  transports: Transports,
  options: NeemataRuntimeTransportOptions<Transports>,
): ApplicationHostTransportConfig<Transports> {
  const config = {} as ApplicationHostTransportConfig<Transports>

  for (const key in transports) {
    // Neem thread options cross a worker boundary as plain values; the host
    // config expects injectables, so wrap them here
    config[key] = {
      transport: transports[key],
      options: createValueInjectable(options[key]),
    }
  }

  return config
}
