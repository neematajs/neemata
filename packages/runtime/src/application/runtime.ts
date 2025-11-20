import type { BaseRuntimeOptions } from '../core/runtime.ts'
import type { AnyRootRouter } from './api/router.ts'
import type { ApplicationConfig } from './config.ts'
import { BaseRuntime } from '../core/runtime.ts'
import { ApplicationApi } from './api/api.ts'
import { ApplicationHooks } from './hooks.ts'

export interface ApplicationRuntimeOptions extends BaseRuntimeOptions {
  router: AnyRootRouter
  filters: ApplicationConfig['filters']
  guards: ApplicationConfig['guards']
  middlewares: ApplicationConfig['middlewares']
  hooks: ApplicationConfig['hooks']
  api: ApplicationConfig['api']
}

export class ApplicationRuntime extends BaseRuntime {
  applicationHooks: ApplicationHooks
  api: ApplicationApi

  constructor(public options: ApplicationRuntimeOptions) {
    super()
    this.applicationHooks = new ApplicationHooks()
    this.api = new ApplicationApi({
      container: this.container,
      logger: this.logger,
      router: options.router,
      filters: options.filters,
      guards: options.guards,
      middlewares: options.middlewares,
      timeout: options.api.timeout,
    })
  }

  protected async _initialize() {
    for (const hook of this.options.hooks) {
      this.applicationHooks.hook(hook.name, async (...args: any[]) => {
        const ctx = await this.container.createContext(hook.dependencies)
        await hook.handler(ctx, ...args)
      })
    }
  }

  protected async _dispose() {
    this.applicationHooks.removeAllHooks()
  }

  protected *_dependents() {
    yield* this.options.filters
    yield* this.options.guards
    yield* this.options.middlewares
    yield* this.options.hooks
    for (const { procedure } of this.api.procedures.values()) {
      yield procedure
      yield* procedure.guards
      yield* procedure.middlewares
    }
  }
}
