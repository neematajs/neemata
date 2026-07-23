import type {
  ExecutionEnvironmentLifecycleHooks,
  ExecutionEnvironmentPlugin,
  LazyInjectable,
  Scope,
} from '@nmtjs/core'
import type { ProxyableTransportType, Transport } from '@nmtjs/gateway'
import type { ConnectionType } from '@nmtjs/protocol'
import { assertUniqueMetaBindings } from '@nmtjs/core'

import type { ApiOptions, ApplicationResolvedProcedure } from './api/api.ts'
import type { AnyFilter } from './api/filters.ts'
import type { AnyGuard } from './api/guards.ts'
import type { AnyMiddleware } from './api/middlewares.ts'
import type { AnyRootRouter, AnyRouterMetaBinding } from './api/router.ts'
import type { AnyHook } from './hook.ts'
import { kApplicationConfig } from './constants.ts'

export type AnyApplicationConfig = ApplicationConfig<AnyRootRouter>

export type ApplicationTransport<
  Type extends ConnectionType = ConnectionType,
  TransportOptions = any,
  Injections extends {
    [key: string]: LazyInjectable<any, Scope.Connection | Scope.Call>
  } = { [key: string]: LazyInjectable<any, Scope.Connection | Scope.Call> },
  Proxyable extends ProxyableTransportType | undefined =
    | ProxyableTransportType
    | undefined,
> = Transport<
  Type,
  TransportOptions,
  Injections,
  Proxyable,
  ApplicationResolvedProcedure
>

export interface ApplicationConfig<
  Router extends AnyRootRouter = AnyRootRouter,
> {
  [kApplicationConfig]: any
  router: Router
  api: Pick<ApiOptions, 'timeout'>
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
) {
  const {
    router,
    guards = [],
    middlewares = [],
    meta = [],
    plugins = [],
    api = {} as ApplicationConfig['api'],
    filters = [] as ApplicationConfig['filters'],
    hooks = [] as ApplicationConfig['hooks'],
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
  } satisfies AnyApplicationConfig) as ApplicationConfig<R>
}

export function isApplicationConfig(value: any): value is ApplicationConfig {
  return Boolean(value?.[kApplicationConfig])
}
