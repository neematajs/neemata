import type { Dependant } from '@nmtjs/core'
import type { GatewayOptions, Transport } from '@nmtjs/gateway'
import { Gateway } from '@nmtjs/gateway'
import { JsonFormat } from '@nmtjs/json-format/server'
import { MsgpackFormat } from '@nmtjs/msgpack-format/server'
import { ProtocolFormats } from '@nmtjs/protocol/server'

import type { ApplicationConfig } from '../application/config.ts'
import type {
  AnyFilter,
  AnyGuard,
  AnyMiddleware,
  AnyProcedure,
  AnyRouter,
  kDefaultProcedure as kDefaultProcedureKey,
} from '../application/index.ts'
import type { ServerConfig } from '../server/config.ts'
import { ApplicationApi } from '../application/api/api.ts'
import { ApplicationHooks } from '../application/hooks.ts'
import {
  isProcedure,
  isRootRouter,
  isRouter,
  kDefaultProcedure,
  kRootRouter,
} from '../application/index.ts'
import { LifecycleHook, WorkerType } from '../enums.ts'
import { BaseWorkerRuntime } from './base.ts'

export interface ApplicationWorkerRuntimeOptions {
  name: string
  path: string
  transports: { [key: string]: any }
}

export class ApplicationWorkerRuntime extends BaseWorkerRuntime {
  api!: ApplicationApi
  applicationHooks!: ApplicationHooks
  gateway!: Gateway
  transports!: GatewayOptions['transports']

  routers = new Map<string | kRootRouter, AnyRouter>()
  procedures = new Map<
    string | kDefaultProcedureKey,
    { procedure: AnyProcedure; path: AnyRouter[] }
  >()
  filters = new Set<AnyFilter>()
  middlewares = new Set<AnyMiddleware>()
  guards = new Set<AnyGuard>()

  constructor(
    readonly config: ServerConfig,
    readonly runtimeOptions: ApplicationWorkerRuntimeOptions,
    protected appConfig: ApplicationConfig,
  ) {
    super(
      config,
      {
        logger: config.logger,
        name: `Worker ${runtimeOptions.name}`,
        plugins: appConfig.plugins,
      },
      WorkerType.Application,
    )

    this.applicationHooks = new ApplicationHooks()

    this.api = new ApplicationApi({
      timeout: this.appConfig.api.timeout,
      container: this.container,
      logger: this.logger,
      filters: this.filters,
      middlewares: this.middlewares,
      guards: this.guards,
      procedures: this.procedures,
    })
  }

  async start() {
    await this.initialize()

    this.transports = {}

    for (const key in this.runtimeOptions.transports) {
      const options = this.runtimeOptions.transports[key]
      const { factory, proxyable } = this.appConfig.transports[key] as Transport
      this.transports[key] = { transport: await factory(options), proxyable }
    }

    this.gateway = new Gateway({
      logger: this.logger,
      container: this.container,
      hooks: this.lifecycleHooks,
      formats: new ProtocolFormats([new JsonFormat(), new MsgpackFormat()]),
      transports: this.transports,
      api: this.api,
      identity: this.appConfig.identity,
    })

    return await this.gateway.start().finally(async () => {
      await this.lifecycleHooks.callHook(LifecycleHook.Start)
    })
  }

  async stop() {
    await this.gateway.stop()
    await this.dispose()
    await this.lifecycleHooks.callHook(LifecycleHook.Stop)
  }

  async reload(appConfig: ApplicationConfig): Promise<void> {
    await this.dispose()
    this.appConfig = appConfig
    this.plugins = appConfig.plugins
    await this.initialize()
    this.gateway.options.identity =
      this.appConfig.identity ?? this.gateway.options.identity
    await this.gateway.reload()
  }

  async initialize(): Promise<void> {
    this.registerApi()
    this.lifecycleHooks.addHooks(this.appConfig.lifecycleHooks)
    await super.initialize()
  }

  protected async _initialize(): Promise<void> {
    await super._initialize()

    for (const hook of this.appConfig.hooks) {
      this.applicationHooks.hook(hook.name, async (...args: any[]) => {
        const ctx = await this.container.createContext(hook.dependencies)
        await hook.handler(ctx, ...args)
      })
    }
  }

  protected async _dispose(): Promise<void> {
    this.applicationHooks.removeAllHooks()
    await super._dispose()
    this.lifecycleHooks.removeHooks(this.appConfig.lifecycleHooks)
    this.filters.clear()
    this.middlewares.clear()
    this.guards.clear()
    this.routers.clear()
    this.procedures.clear()
  }

  protected *_dependents(): Generator<Dependant> {
    yield* this.appConfig.filters
    yield* this.appConfig.guards
    yield* this.appConfig.middlewares
    yield* this.appConfig.hooks
    for (const { procedure } of this.procedures.values()) {
      yield procedure
      yield* procedure.guards
      yield* procedure.middlewares
    }
  }

  protected registerApi() {
    const { router, filters, guards, middlewares } = this.appConfig

    if (this.routers.has(kRootRouter)) {
      throw new Error('Root router already registered')
    }

    if (!isRootRouter(router)) {
      throw new Error('Root router must be a root router')
    }

    this.routers.set(kRootRouter, router)
    this.registerRouter(router, [])

    if (router.default) {
      if (!isProcedure(router.default)) {
        throw new Error('Root router default must be a procedure')
      }
      this.procedures.set(kDefaultProcedure, {
        procedure: router.default,
        path: [router],
      })
    }

    for (const filter of filters) this.filters.add(filter)
    for (const middleware of middlewares) this.middlewares.add(middleware)
    for (const guard of guards) this.guards.add(guard)
  }

  protected registerRouter(router: AnyRouter, path: AnyRouter[] = []) {
    for (const route of Object.values(router.routes)) {
      if (isRouter(route)) {
        const name = route.contract.name
        if (!name) throw new Error('Nested routers must have a name')
        if (this.routers.has(name)) {
          throw new Error(`Router ${String(name)} already registered`)
        }
        this.routers.set(name, route)
        this.registerRouter(route, [...path, router])
      } else if (isProcedure(route)) {
        const name = route.contract.name
        if (!name) throw new Error('Procedures must have a name')
        if (this.procedures.has(name)) {
          throw new Error(`Procedure ${name} already registered`)
        }
        this.procedures.set(name, { procedure: route, path: [...path, router] })
      }
    }
  }
}
