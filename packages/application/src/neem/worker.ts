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
> implements NeemRuntime<THost> {
  readonly host: ApplicationHost<THost['transports']>
  private definition: THost

  constructor(readonly ctx: NeemataRuntimeContext<THost>) {
    this.definition = ctx.definition
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

  async reload(definition: THost) {
    if (
      definition.identity !== this.definition.identity ||
      !haveSameTransports(definition.transports, this.definition.transports)
    ) {
      // The running gateway can replace application state, but changing its
      // wire boundary requires Neem to recreate and re-advertise the worker.
      throw new Error(
        'Application identity or transport changes require a full runtime reload',
      )
    }

    await this.host.reload(definition)
    this.definition = definition
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

function haveSameTransports(
  next: Record<string, ApplicationTransport>,
  current: Record<string, ApplicationTransport>,
): boolean {
  const keys = Object.keys(next)
  return (
    keys.length === Object.keys(current).length &&
    keys.every((key) => next[key] === current[key])
  )
}
