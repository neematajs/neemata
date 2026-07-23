import type { Container, Dependant, Logger } from '@nmtjs/core'
import type { GatewayApi } from '@nmtjs/gateway'
import {
  ExecutionEnvironment,
  ExecutionEnvironmentLifecycleHook,
  forkLogger,
} from '@nmtjs/core'

import type { ApiOptions, ApplicationResolvedProcedure } from './api/api.ts'
import type { AnyFilter } from './api/filters.ts'
import type { AnyGuard } from './api/guards.ts'
import type { AnyMiddleware } from './api/middlewares.ts'
import type { AnyProcedure } from './api/procedure.ts'
import type { AnyRootRouter, AnyRouter } from './api/router.ts'
import type { ApplicationConfig } from './config.ts'
import { ApplicationApi } from './api/api.ts'
import { kRootRouterSources } from './api/constants.ts'
import { isProcedure } from './api/procedure.ts'
import { isRootRouter, isRouter } from './api/router.ts'
import { ApplicationHooks } from './hooks.ts'

export interface NeemataApplicationOptions {
  logger: Logger
  container?: Container
  name?: string
}

export class NeemataApplication {
  protected readonly execution: ExecutionEnvironment
  readonly applicationHooks = new ApplicationHooks()
  readonly api: GatewayApi<ApplicationResolvedProcedure>

  readonly routers = new Set<AnyRouter>()
  readonly procedures = new Map<
    string,
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
      lifecycleHooks: this.appConfig.lifecycleHooks,
      plugins: this.appConfig.plugins,
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

  get lifecycleHooks() {
    return this.execution.lifecycleHooks
  }

  async initialize(): Promise<void> {
    this.registerApi()
    await this.initializeExecutionEnv()
    await this.lifecycleHooks.callHook(
      ExecutionEnvironmentLifecycleHook.BeforeInitialize,
      this,
    )
    await this.initializeApplicationHooks()
    await this.lifecycleHooks.callHook(
      ExecutionEnvironmentLifecycleHook.AfterInitialize,
      this,
    )
  }

  async dispose(): Promise<void> {
    await this.lifecycleHooks.callHook(
      ExecutionEnvironmentLifecycleHook.BeforeDispose,
      this,
    )
    this.applicationHooks.removeAllHooks()
    await this.lifecycleHooks.callHook(
      ExecutionEnvironmentLifecycleHook.AfterDispose,
      this,
    )
    await this.disposeExecutionEnv()
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

    for (const router of this.routers) {
      yield* router.meta
      yield* router.guards
      yield* router.middlewares
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

    if (Array.from(this.routers.values()).some((r) => isRootRouter(r))) {
      throw new Error('Root router already registered')
    }

    if (!isRootRouter(router)) {
      throw new Error('Root router must be a root router')
    }

    this.routers.add(router)
    this.registerRootRouter(router)

    for (const filter of filters) this.filters.add(filter)
    for (const middleware of middlewares) this.middlewares.add(middleware)
    for (const guard of guards) this.guards.add(guard)
  }

  protected registerRootRouter(router: AnyRootRouter): void {
    this.warnDuplicateRootRoutes(router)
    for (const source of router[kRootRouterSources]) {
      this.routers.add(source)
      this.registerRouter(source, [router])
    }
  }

  protected warnDuplicateRootRoutes(router: AnyRootRouter): void {
    const routes = new Set<string>()
    const duplicates = new Set<string>()

    for (const source of router[kRootRouterSources]) {
      for (const route of Object.keys(source.routes)) {
        if (routes.has(route)) duplicates.add(route)
        else routes.add(route)
      }
    }

    for (const route of duplicates) {
      this.logger.warn({ route }, 'Duplicate root router route')
    }
  }

  protected registerRouter(router: AnyRouter, path: AnyRouter[] = []): void {
    for (const route of Object.values(router.routes)) {
      if (isRouter(route)) {
        const name = route.contract.name
        if (!name) throw new Error('Nested routers must have a name')
        for (const router of this.routers) {
          if (router.contract.name === name) {
            throw new Error(`Router ${String(name)} already registered`)
          }
        }
        this.routers.add(route)
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
