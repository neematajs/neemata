import type { Container, Dependant, Logger } from '@nmtjs/core'
import type { GatewayApi } from '@nmtjs/gateway'
import { ExecutionEnvironment, forkLogger } from '@nmtjs/core'

import type { ApiOptions, ApplicationResolvedProcedure } from './api/api.ts'
import type { kDefaultProcedure as kDefaultProcedureKey } from './api/constants.ts'
import type { AnyFilter } from './api/filters.ts'
import type { AnyGuard } from './api/guards.ts'
import type { AnyMiddleware } from './api/middlewares.ts'
import type { AnyProcedure } from './api/procedure.ts'
import type { AnyRootRouter, AnyRouter } from './api/router.ts'
import type { ApplicationConfig } from './config.ts'
import { ApplicationApi } from './api/api.ts'
import {
  kDefaultProcedure,
  kRootRouter,
  kRootRouterSources,
} from './api/constants.ts'
import { isProcedure } from './api/procedure.ts'
import { isRootRouter, isRouter } from './api/router.ts'
import { LifecycleHook } from './enums.ts'
import { ApplicationHooks } from './hooks.ts'
import { LifecycleHooks } from './lifecycle.ts'

export interface NeemataApplicationOptions {
  logger: Logger
  container?: Container
  name?: string
}

export class NeemataApplication {
  protected readonly execution: ExecutionEnvironment
  readonly lifecycleHooks = new LifecycleHooks()
  readonly applicationHooks = new ApplicationHooks()
  readonly api: GatewayApi<ApplicationResolvedProcedure>

  readonly routers = new Map<string | kRootRouter, AnyRouter>()
  readonly procedures = new Map<
    string | kDefaultProcedureKey,
    { procedure: AnyProcedure; path: AnyRouter[] }
  >()
  readonly filters = new Set<AnyFilter>()
  readonly middlewares = new Set<AnyMiddleware>()
  readonly guards = new Set<AnyGuard>()

  constructor(
    protected appConfig: ApplicationConfig,
    options: NeemataApplicationOptions,
  ) {
    const logger = options.name
      ? forkLogger(options.logger, undefined, undefined, {
          application: options.name,
        })
      : options.logger
    this.execution = new ExecutionEnvironment({
      logger,
      container: options.container,
      label: 'NeemataApplication',
    })

    this.api = new ApplicationApi({
      timeout: this.appConfig.api.timeout,
      container: this.container,
      logger: this.logger,
      meta: this.appConfig.meta,
      filters: this.filters,
      middlewares: this.middlewares,
      guards: this.guards,
      procedures: this.procedures,
    } satisfies ApiOptions)
  }

  get logger() {
    return this.execution.logger
  }

  get container() {
    return this.execution.container
  }

  async initialize(): Promise<void> {
    this.registerApi()
    this.lifecycleHooks.addHooks(this.appConfig.lifecycleHooks)
    await this.initializePlugins()
    await this.initializeExecutionEnv()
    await this.lifecycleHooks.callHook(LifecycleHook.BeforeInitialize, this)
    await this.initializeApplicationHooks()
    await this.lifecycleHooks.callHook(LifecycleHook.AfterInitialize, this)
  }

  async dispose(): Promise<void> {
    await this.lifecycleHooks.callHook(LifecycleHook.BeforeDispose, this)
    this.applicationHooks.removeAllHooks()
    await this.lifecycleHooks.callHook(LifecycleHook.AfterDispose, this)
    await this.disposeExecutionEnv()
    await this.disposePlugins()
    this.lifecycleHooks.removeHooks(this.appConfig.lifecycleHooks)
    this.filters.clear()
    this.middlewares.clear()
    this.guards.clear()
    this.routers.clear()
    this.procedures.clear()
  }

  protected async initializeApplicationHooks(): Promise<void> {
    for (const hook of this.appConfig.hooks) {
      this.applicationHooks.hook(hook.name, async (...args: any[]) => {
        const ctx = await this.container.createContext(hook.dependencies)
        await hook.handler(ctx, ...args)
      })
    }
  }

  protected async initializePlugins(): Promise<void> {
    for (const { hooks, injections } of this.appConfig.plugins) {
      if (injections) this.container.provide(injections)
      if (hooks) this.lifecycleHooks.addHooks(hooks)
    }
  }

  protected async disposePlugins(): Promise<void> {
    for (const { hooks, injections } of this.appConfig.plugins) {
      if (hooks) this.lifecycleHooks.removeHooks(hooks)
      if (injections) {
        for (const injection of injections) {
          await this.container.disposeInjectableInstances(injection.token)
        }
      }
    }
  }

  protected async initializeExecutionEnv(): Promise<void> {
    await this.execution.initialize(this.dependents())
  }

  protected async disposeExecutionEnv(): Promise<void> {
    await this.execution.dispose()
  }

  protected *dependents(): Generator<Dependant> {
    yield* this.appConfig.filters
    yield* this.appConfig.guards
    yield* this.appConfig.middlewares
    yield* this.appConfig.meta
    yield* this.appConfig.hooks
    for (const router of this.routers.values()) {
      yield* router.meta
    }
    for (const { procedure } of this.procedures.values()) {
      yield procedure
      yield* procedure.meta
      yield* procedure.guards
      yield* procedure.middlewares
    }
  }

  protected registerApi(): void {
    const { router, filters, guards, middlewares } = this.appConfig

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
  }

  protected registerRootRouter(router: AnyRootRouter): void {
    for (const source of router[kRootRouterSources]) {
      this.registerRouter(source, this.getRootSourcePath(router, source))
    }
  }

  protected getRootSourcePath(
    root: AnyRootRouter,
    source: AnyRouter,
  ): AnyRouter[] {
    return this.hasRouteContext(source) ? [root, source] : [root]
  }

  protected hasRouteContext(router: AnyRouter): boolean {
    return (
      router.meta.length > 0 ||
      router.guards.size > 0 ||
      router.middlewares.size > 0 ||
      router.timeout !== undefined
    )
  }

  protected registerRouter(router: AnyRouter, path: AnyRouter[] = []): void {
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
