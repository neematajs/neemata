import type {
  ExecutionEnvironmentLifecycleHooks,
  ExecutionEnvironmentPlugin,
} from '@nmtjs/core'
import type {
  Transport,
  TransportInjections,
  TransportProxyable,
} from '@nmtjs/gateway'
import { assertUniqueMetaBindings } from '@nmtjs/core'

import type { ApplicationResolvedProcedure } from './api/api.ts'
import type { AnyFilter } from './api/filters.ts'
import type { AnyGuard } from './api/guards.ts'
import type { AnyMiddleware } from './api/middlewares.ts'
import type { AnyRootRouter, AnyRouterMetaBinding } from './api/router.ts'
import type { AnyHook } from './hook.ts'
import { kApplicationConfig } from './constants.ts'

export type AnyApplicationConfig = ApplicationConfig<AnyRootRouter>

export type ApplicationTransport<
  TransportOptions = any,
  Injections extends TransportInjections = TransportInjections,
  Proxyable extends TransportProxyable = TransportProxyable,
> = Transport<
  TransportOptions,
  Injections,
  Proxyable,
  ApplicationResolvedProcedure
>

export type ApplicationTransports = Record<string, ApplicationTransport>

export interface ApplicationConfig<
  Router extends AnyRootRouter = AnyRootRouter,
> {
  [kApplicationConfig]: true
  router: Router
  api: { timeout?: number }
  plugins: ExecutionEnvironmentPlugin[]
  filters: AnyFilter[]
  middlewares: AnyMiddleware[]
  guards: AnyGuard[]
  meta: AnyRouterMetaBinding[]
  hooks: AnyHook[]
  lifecycleHooks: ExecutionEnvironmentLifecycleHooks['_']['config']
}

export function defineApplication<R extends AnyRootRouter>(
  options: Pick<ApplicationConfig<R>, 'router'> &
    Partial<Omit<ApplicationConfig<R>, 'router'>>,
): ApplicationConfig<R> {
  const {
    router,
    guards = [],
    middlewares = [],
    meta = [],
    plugins = [],
    api = {},
    filters = [],
    hooks = [],
    lifecycleHooks = {},
  } = options

  assertUniqueMetaBindings(meta, 'application config')

  return Object.freeze({
    [kApplicationConfig]: true,
    router,
    api,
    filters,
    plugins,
    guards,
    middlewares,
    meta,
    hooks,
    lifecycleHooks,
  } satisfies ApplicationConfig<R>)
}

export function isApplicationConfig(value: any): value is ApplicationConfig {
  return Boolean(value?.[kApplicationConfig])
}
