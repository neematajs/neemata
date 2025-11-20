import type { ConnectionIdentityResolver, TransportV2 } from '@nmtjs/gateway'

import type { LifecycleHooks } from '../core/hooks.ts'
import type { RuntimePlugin } from '../core/plugin.ts'
import type { ApiOptions } from './api/api.ts'
import type { AnyFilter } from './api/filters.ts'
import type { AnyGuard } from './api/guards.ts'
import type { AnyMiddleware } from './api/middlewares.ts'
import type { AnyRootRouter } from './api/router.ts'
import type { AnyHook } from './hook.ts'
import { kApplicationConfig } from './constants.ts'

export type AnyApplicationConfig = ApplicationConfig<AnyRootRouter>

export interface ApplicationConfig<
  Router extends AnyRootRouter = AnyRootRouter,
  Transports extends Record<string, TransportV2> = Record<string, TransportV2>,
> {
  [kApplicationConfig]: any
  router: Router
  api: Pick<ApiOptions, 'timeout'>
  transports: Transports
  identityResolver?: ConnectionIdentityResolver
  plugins: RuntimePlugin[]
  filters: AnyFilter[]
  middlewares: AnyMiddleware[]
  guards: AnyGuard[]
  hooks: AnyHook[]
  lifecycleHooks: LifecycleHooks['_']['config']
}

export function defineApplication<
  R extends AnyRootRouter,
  T extends Record<string, TransportV2> = Record<string, TransportV2>,
>(
  options: Pick<ApplicationConfig<R, T>, 'router'> &
    Partial<Omit<ApplicationConfig<R, T>, 'router'>>,
) {
  const {
    router,
    transports = {},
    guards = [],
    middlewares = [],
    plugins = [],
    api = {} as ApplicationConfig['api'],
    filters = [] as ApplicationConfig['filters'],
    hooks = [] as ApplicationConfig['hooks'],
    lifecycleHooks = {},
    identityResolver,
  } = options

  return Object.freeze({
    [kApplicationConfig]: true,
    router,
    transports,
    api,
    filters,
    plugins,
    guards,
    middlewares,
    hooks,
    lifecycleHooks,
    identityResolver,
  } satisfies AnyApplicationConfig) as ApplicationConfig<R, T>
}

export function isApplicationConfig(value: any): value is ApplicationConfig {
  return Boolean(value?.[kApplicationConfig])
}
