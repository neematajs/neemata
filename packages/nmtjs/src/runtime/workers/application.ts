import type {
  ApplicationHost,
  ApplicationHostDefinition,
  ApplicationHostOptions,
  ApplicationResolvedProcedure,
  ApplicationTransport,
  NeemataApplication,
  TransportOptionsOf,
} from '@nmtjs/application'
import type { Gateway, GatewayOptions } from '@nmtjs/gateway'
import { createApplicationHost, LifecycleHook } from '@nmtjs/application'
import { JsonFormat } from '@nmtjs/json-format/server'
import { MsgpackFormat } from '@nmtjs/msgpack-format/server'
import { ProtocolFormats } from '@nmtjs/protocol/server'

import type { ServerApplicationConfig, ServerConfig } from '../server/config.ts'
import { WorkerType } from '../enums.ts'
import { BaseWorkerRuntime } from './base.ts'

export interface ApplicationWorkerRuntimeOptions {
  name: string
  path: string
  transports: ServerApplicationConfig['threads'][number]
}

export class ApplicationWorkerRuntime extends BaseWorkerRuntime {
  host!: ApplicationHost

  constructor(
    readonly config: ServerConfig,
    readonly runtimeOptions: ApplicationWorkerRuntimeOptions,
    protected hostDefinition: ApplicationHostDefinition,
  ) {
    super(
      config,
      {
        logger: config.logger,
        name: `Worker ${runtimeOptions.name}`,
        plugins: [],
      },
      WorkerType.Application,
    )
  }

  get application(): NeemataApplication {
    return this.host.application
  }

  get api() {
    return this.application.api
  }

  get applicationHooks() {
    return this.application.applicationHooks
  }

  get gateway(): Gateway<ApplicationResolvedProcedure> {
    return this.host.gateway
  }

  get transports(): GatewayOptions<ApplicationResolvedProcedure>['transports'] {
    return this.host.transports
  }

  async start() {
    await this.initialize()
    this.host = createApplicationHost(this.hostDefinition.application, {
      name: this.runtimeOptions.name,
      logger: this.logger,
      container: this.container,
      formats: new ProtocolFormats([new JsonFormat(), new MsgpackFormat()]),
      ...this.resolveHostOptions(),
    })
    return this.host.start()
  }

  async stop() {
    await this.host.stop()
    await this.dispose()
    await this.lifecycleHooks.callHook(LifecycleHook.Stop)
  }

  async reload(hostDefinition: ApplicationHostDefinition): Promise<void> {
    this.hostDefinition = hostDefinition
    await this.host.reload(hostDefinition.application)
  }

  protected *_dependents() {}

  protected resolveHostOptions(): Pick<
    ApplicationHostOptions,
    'transports' | 'gateway' | 'identity'
  > {
    const config = this.config.applications[
      this.runtimeOptions.name
    ] as ServerApplicationConfig

    if (!config) {
      throw new Error(
        `Missing server application config: ${this.runtimeOptions.name}`,
      )
    }

    return {
      transports: createHostTransportConfig(
        this.hostDefinition.transports,
        this.runtimeOptions.transports,
      ),
      gateway: config.gateway,
      identity: config.identity,
    }
  }
}

function createHostTransportConfig<
  Transports extends Record<string, ApplicationTransport>,
>(
  transports: Transports,
  options: { [K in keyof Transports]: TransportOptionsOf<Transports[K]> },
) {
  const config = {} as {
    [K in keyof Transports]: {
      transport: Transports[K]
      options: TransportOptionsOf<Transports[K]>
    }
  }

  for (const key in transports) {
    config[key] = { transport: transports[key], options: options[key] }
  }

  return config
}
