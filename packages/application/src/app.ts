import type { AnyInjectable, Dependant, Logger } from '@nmtjs/core'
import type { GatewayOptions, ProxyableTransportType } from '@nmtjs/gateway'
import {
  Container,
  CoreInjectables,
  getDepedencencyInjectable,
} from '@nmtjs/core'
import { Gateway } from '@nmtjs/gateway'
import { JsonFormat } from '@nmtjs/json-format/server'
import { MsgpackFormat } from '@nmtjs/msgpack-format/server'
import { ProtocolFormats } from '@nmtjs/protocol/server'

import type { ApplicationResolvedProcedure } from './api/api.ts'
import type { AnyFilter } from './api/filters.ts'
import type { AnyGuard } from './api/guards.ts'
import type {
  AnyMiddleware,
  AnyProcedure,
  AnyRootRouter,
  AnyRouter,
} from './api/index.ts'
import type {
  AnyApplicationConfig,
  ApplicationConfig,
  ApplicationTransport,
} from './config.ts'
import { ApplicationApi } from './api/api.ts'
import {
  kDefaultProcedure,
  kRootRouter,
  kRootRouterSources,
} from './api/constants.ts'
import { isProcedure, isRootRouter, isRouter } from './api/index.ts'
import { LifecycleHook } from './enums.ts'
import { ApplicationHooks } from './hooks.ts'
import { LifecycleHooks } from './lifecycle.ts'

export type NeemataApplicationMode = 'development' | 'production'

export type NeemataApplicationUpstream = {
  type: ProxyableTransportType
  url: string
}

export type NeemataAppTransportOptions<
  TApplication extends ApplicationConfig<any, any>,
> =
  TApplication extends ApplicationConfig<any, infer Transports>
    ? {
        [K in keyof Transports]: Transports[K] extends ApplicationTransport<
          any,
          infer Options
        >
          ? Options
          : never
      }
    : never

export type NeemataApplicationOptions<
  TApplication extends ApplicationConfig<any, any>,
> = {
  logger: Logger
  mode?: NeemataApplicationMode
  transports: NeemataAppTransportOptions<TApplication>
}

export class NeemataApplication<
  TApplication extends ApplicationConfig<any, any> = AnyApplicationConfig,
> {
  readonly logger: Logger
  readonly container: Container
  readonly lifecycleHooks = new LifecycleHooks()
  readonly applicationHooks = new ApplicationHooks()
  readonly filters = new Set<AnyFilter>()
  readonly middlewares = new Set<AnyMiddleware>()
  readonly guards = new Set<AnyGuard>()
  readonly routers = new Map<string | typeof kRootRouter, AnyRouter>()
  readonly procedures = new Map<
    string | typeof kDefaultProcedure,
    { procedure: AnyProcedure; path: AnyRouter[] }
  >()

  private api?: ApplicationApi
  private gateway?: Gateway<ApplicationResolvedProcedure>
  private transports?: GatewayOptions<ApplicationResolvedProcedure>['transports']

  constructor(
    readonly config: TApplication,
    readonly options: NeemataApplicationOptions<TApplication>,
  ) {
    this.logger = options.logger
    this.container = new Container({ logger: this.logger })
  }

  async start(): Promise<readonly NeemataApplicationUpstream[]> {
    await this.initialize()

    this.transports = {}
    for (const key in this.options.transports) {
      const transportOptions = this.options.transports[key]
      const { factory, proxyable } = this.config.transports[
        key
      ] as ApplicationTransport
      this.transports[key] = {
        transport: await factory(transportOptions),
        proxyable,
      }
    }

    this.gateway = new Gateway({
      ...this.config.gateway,
      logger: this.logger,
      container: this.container,
      hooks: this.lifecycleHooks,
      formats: new ProtocolFormats([new JsonFormat(), new MsgpackFormat()]),
      transports: this.transports,
      api: this.api!,
      identity: this.config.identity,
    })

    const upstreams = await this.gateway.start()
    await this.lifecycleHooks.callHook(LifecycleHook.Start as never)
    return upstreams
  }

  async stop(): Promise<void> {
    await this.gateway?.stop()
    await this.dispose()
    await this.lifecycleHooks.callHook(LifecycleHook.Stop as never)
  }

  private async initialize() {
    this.registerApi()
    this.lifecycleHooks.addHooks(this.config.lifecycleHooks)
    await this.initializePlugins()
    await this.initializeApplicationHooks()
    await this.initializeContainer()
    await this.lifecycleHooks.callHook(LifecycleHook.BeforeInitialize, this)
    await this.lifecycleHooks.callHook(LifecycleHook.AfterInitialize, this)
  }

  private async dispose() {
    await this.lifecycleHooks.callHook(LifecycleHook.BeforeDispose, this)
    this.applicationHooks.removeAllHooks()
    await this.container.dispose()
    await this.disposePlugins()
    this.lifecycleHooks.removeHooks(this.config.lifecycleHooks)
    this.filters.clear()
    this.middlewares.clear()
    this.guards.clear()
    this.routers.clear()
    this.procedures.clear()
    await this.lifecycleHooks.callHook(LifecycleHook.AfterDispose, this)
  }

  private async initializePlugins() {
    for (const { hooks, injections } of this.config.plugins) {
      if (injections) this.container.provide(injections)
      if (hooks) this.lifecycleHooks.addHooks(hooks)
    }
  }

  private async disposePlugins() {
    for (const { hooks, injections } of this.config.plugins) {
      if (hooks) this.lifecycleHooks.removeHooks(hooks)
      if (injections) {
        for (const injection of injections) {
          await this.container.disposeInjectableInstances(injection.token)
        }
      }
    }
  }

  private async initializeApplicationHooks() {
    for (const hook of this.config.hooks) {
      this.applicationHooks.hook(hook.name, async (...args: unknown[]) => {
        const hookCtx = await this.container.createContext(hook.dependencies)
        await hook.handler(hookCtx, ...args)
      })
    }
  }

  private async initializeContainer() {
    this.container.provide(CoreInjectables.logger, this.logger)

    const dependencies = new Set<AnyInjectable>()

    for (const injectable of this.injectables()) {
      for (const key in injectable.dependencies) {
        const dependency = injectable.dependencies[key]
        dependencies.add(getDepedencencyInjectable(dependency))
      }
    }

    await this.container.initialize(dependencies)
  }

  private *injectables(): Generator<Dependant> {
    const { filters, guards, middlewares, hooks, meta } = this.config

    yield* hooks
    yield* filters
    yield* middlewares
    yield* guards
    yield* meta

    for (const router of this.routers.values()) yield* router.meta

    for (const { procedure } of this.procedures.values()) {
      yield procedure
      yield* procedure.meta
      yield* procedure.guards
      yield* procedure.middlewares
    }
  }

  private registerApi() {
    const { router, filters, guards, middlewares } = this.config

    if (this.routers.has(kRootRouter)) {
      throw new Error('Root router already registered')
    }
    if (!isRootRouter(router)) {
      throw new Error('Root router must be a root router')
    }

    this.routers.set(kRootRouter, router)
    this.registerRootRouter(router)

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

    this.api = new ApplicationApi({
      timeout: this.config.api.timeout,
      container: this.container,
      logger: this.logger,
      meta: this.config.meta,
      filters: this.filters,
      middlewares: this.middlewares,
      guards: this.guards,
      procedures: this.procedures,
    })
  }

  private registerRootRouter(router: AnyRootRouter) {
    for (const source of router[kRootRouterSources]) {
      this.registerRouter(source, this.getRootSourcePath(router, source))
    }
  }

  private getRootSourcePath(root: AnyRootRouter, source: AnyRouter) {
    return this.hasRouteContext(source) ? [root, source] : [root]
  }

  private hasRouteContext(router: AnyRouter): boolean {
    return (
      router.meta.length > 0 ||
      router.guards.size > 0 ||
      router.middlewares.size > 0 ||
      router.timeout !== undefined
    )
  }

  private registerRouter(router: AnyRouter, path: AnyRouter[]) {
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

export function createApp<
  const TApplication extends ApplicationConfig<any, any>,
>(
  config: TApplication,
  options: NeemataApplicationOptions<TApplication>,
): NeemataApplication<TApplication> {
  return new NeemataApplication(config, options)
}
