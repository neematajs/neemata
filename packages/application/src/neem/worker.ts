import type { NeemRuntime } from '@nmtjs/neem'
import { JsonFormat } from '@nmtjs/json-format/server'
import { MsgpackFormat } from '@nmtjs/msgpack-format/server'
import { defineRuntimeWorker } from '@nmtjs/neem'
import { ProtocolFormats } from '@nmtjs/protocol/server'

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
> implements NeemRuntime
{
  readonly host: ApplicationHost<THost['transports']>

  constructor(readonly ctx: NeemataRuntimeContext<THost>) {
    this.host = createApplicationHost(ctx.definition.application, {
      name: ctx.name,
      logger: ctx.logger,
      formats: new ProtocolFormats([new JsonFormat(), new MsgpackFormat()]),
      transports: createHostTransportConfig(
        ctx.definition.transports,
        ctx.data,
      ),
      gateway: ctx.definition.gateway,
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
    config[key] = { transport: transports[key], options: options[key] }
  }

  return config
}
