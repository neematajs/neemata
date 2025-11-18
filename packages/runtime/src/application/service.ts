import type { AnyRouter } from '@nmtjs/api'
import { createRootRouter } from '@nmtjs/api'

import type { LifecycleHooks } from '../../core/src/hooks/lifecycle-hooks.ts'
import type { ApplicationConfig } from './config.ts'
import type { ApplicationType } from './enums.ts'
import type { ApplicationRegistry } from './registry.ts'

export class ApplicationService<
  Config extends ApplicationConfig = ApplicationConfig,
> {
  constructor(
    readonly id: string,
    readonly type: ApplicationType,
    readonly config: Config,
  ) {}

  get router() {
    return this.config.router
  }

  get filters() {
    return this.config.filters
  }

  get hooks() {
    return this.config.hooks
  }

  get lifecycleHooks() {
    return this.config.lifecycleHooks
  }

  applyToRegistry(registry: ApplicationRegistry) {
    const routers: AnyRouter[] = []
    if (this.config.router) routers.push(this.config.router)
    if (routers.length) {
      const rootRouter = createRootRouter(...routers)
      registry.registerRootRouter(rootRouter)
    }

    for (const [error, filter] of this.config.filters) {
      registry.registerFilter(error, filter)
    }

    for (const hook of this.config.hooks) {
      registry.registerHook(hook)
    }
  }

  configureLifecycleHooks(lifecycleHooks: LifecycleHooks) {
    lifecycleHooks.addHooks(this.config.lifecycleHooks)
  }
}

export function createApplicationService<Config extends ApplicationConfig>(
  id: string,
  type: ApplicationType,
  config: Config,
) {
  return new ApplicationService(id, type, config)
}
