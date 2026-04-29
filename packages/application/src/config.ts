import type { LazyInjectable, Scope } from '@nmtjs/core'
import type {
  ConnectionIdentity,
  GatewayOptions,
  ProxyableTransportType,
  Transport,
} from '@nmtjs/gateway'
import type { ConnectionType } from '@nmtjs/protocol'
import { assertUniqueMetaBindings } from '@nmtjs/core'

import type { ApiOptions, ApplicationResolvedProcedure } from './api/api.ts'
import type { AnyFilter } from './api/filters.ts'
import type { AnyGuard } from './api/guards.ts'
import type { AnyMiddleware } from './api/middlewares.ts'
import type { AnyRootRouter, AnyRouterMetaBinding } from './api/router.ts'
import type { AnyHook } from './hook.ts'
import type { LifecycleHooks } from './lifecycle.ts'
import type { RuntimePlugin } from './plugin.ts'
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
  Transports extends Record<string, ApplicationTransport> = Record<
    string,
    ApplicationTransport
  >,
> {
  [kApplicationConfig]: any
  router: Router
  api: Pick<ApiOptions, 'timeout'>
  gateway: Pick<GatewayOptions, 'streamTimeouts' | 'heartbeat'>
  transports: Transports
  identity?: ConnectionIdentity
  plugins: RuntimePlugin[]
  filters: AnyFilter[]
  middlewares: AnyMiddleware[]
  guards: AnyGuard[]
  meta: AnyRouterMetaBinding[]
  hooks: AnyHook[]
  lifecycleHooks: LifecycleHooks['_']['config']
}

export function defineApplication<
  R extends AnyRootRouter,
  T extends Record<string, ApplicationTransport> = Record<
    string,
    ApplicationTransport
  >,
>(
  options: Pick<ApplicationConfig<R, T>, 'router'> &
    Partial<Omit<ApplicationConfig<R, T>, 'router'>>,
) {
  const {
    router,
    transports = {},
    guards = [],
    middlewares = [],
    meta = [],
    plugins = [],
    api = {} as ApplicationConfig['api'],
    filters = [] as ApplicationConfig['filters'],
    hooks = [] as ApplicationConfig['hooks'],
    lifecycleHooks = {},
    gateway = {},
    identity: identityResolver,
  } = options

  assertUniqueMetaBindings(meta, 'application config')

  return Object.freeze({
    [kApplicationConfig]: true,
    router,
    transports,
    api,
    gateway,
    filters,
    plugins,
    guards,
    middlewares,
    meta,
    hooks,
    lifecycleHooks,
    identity: identityResolver,
  } satisfies AnyApplicationConfig) as ApplicationConfig<R, T>
}

export function isApplicationConfig(value: any): value is ApplicationConfig {
  return Boolean(value?.[kApplicationConfig])
}
