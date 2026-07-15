import type { Callback } from '@nmtjs/common'
import type {
  TAnyProcedureContract,
  TAnyRouterContract,
  TProcedureContract,
  TRouteContract,
  TRouterContract,
} from '@nmtjs/contract'
import type { BaseTypeAny, t } from '@nmtjs/type'
import { c, IsRouterContract } from '@nmtjs/contract'
import { assertUniqueMetaBindings } from '@nmtjs/core'

import type { AnyGuard } from './guards.ts'
import type { AnyCompatibleMetaBinding, CompatibleMetaBinding } from './meta.ts'
import type { AnyMiddleware } from './middlewares.ts'
import type { AnyProcedure } from './procedure.ts'
import { kRootRouter, kRootRouterSources, kRouter } from './constants.ts'

export type RouterMetaBinding<Input> = CompatibleMetaBinding<Input>
export type AnyRouterMetaBinding = AnyCompatibleMetaBinding

export type AnyRouterRoutes = Record<string, AnyProcedure<any> | AnyRouter>
export type AnyRouterContractRoutes = Record<
  string,
  TAnyProcedureContract | TAnyRouterContract
>

export interface AnyRouter {
  contract: TAnyRouterContract
  routes: AnyRouterRoutes
  guards: Set<AnyGuard>
  middlewares: Set<AnyMiddleware>
  meta: readonly AnyRouterMetaBinding[]
  timeout?: number
  [kRouter]: any
}

export interface AnyRootRouter extends AnyRouter {
  [kRootRouter]: any
  [kRootRouterSources]: readonly AnyRouter[]
  contract: TAnyRouterContract<Record<string, TRouteContract>, undefined>
}

export interface Router<Contract extends TAnyRouterContract> extends AnyRouter {
  contract: Contract
  routes: {
    [K in keyof Contract['routes']]: Contract['routes'][K] extends TAnyRouterContract
      ? Router<Contract['routes'][K]>
      : Contract['routes'][K] extends TAnyProcedureContract
        ? AnyProcedure<
            TProcedureContract<
              Contract['routes'][K]['input'],
              Contract['routes'][K]['output'],
              Contract['routes'][K]['stream'],
              Contract['routes'][K]['name']
            >
          >
        : never
  }
  guards: Set<AnyGuard>
  middlewares: Set<AnyMiddleware>
  meta: readonly AnyRouterMetaBinding[]
  timeout?: number
  [kRouter]: any
}

export interface RootRouter<
  Contract extends TAnyRouterContract<
    Record<string, TRouteContract>,
    undefined
  >,
> extends Router<Contract> {
  [kRootRouter]: any
  [kRootRouterSources]: readonly AnyRouter[]
}

export type MergeRoutersRoutesContracts<
  Routers extends readonly TAnyRouterContract[],
> = Routers extends [
  infer First extends TAnyRouterContract,
  ...infer Rest extends TAnyRouterContract[],
]
  ? {
      [K in keyof First['routes']]: First['routes'][K]
    } & MergeRoutersRoutesContracts<Rest>
  : Routers extends [infer First extends TAnyRouterContract]
    ? {
        [K in keyof First['routes']]: First['routes'][K]
      }
    : {}

export type ExtractRouterContracts<
  Routers extends readonly { contract: TAnyRouterContract }[],
> = Routers extends [
  infer First extends { contract: TAnyRouterContract },
  ...infer Rest extends { contract: TAnyRouterContract }[],
]
  ? [First['contract'], ...ExtractRouterContracts<Rest>]
  : []

export type RouterContractsFromRoutes<Routes extends AnyRouterRoutes> = {
  [K in keyof Routes]: Routes[K] extends AnyRouter
    ? Routes[K]['contract']
    : Routes[K] extends AnyProcedure<any>
      ? Routes[K]['contract']
      : never
}

export type RouterContractFromRoutes<Routes extends AnyRouterRoutes> =
  TRouterContract<RouterContractsFromRoutes<Routes>, undefined>

export function createRootRouter<Routers extends readonly AnyRouter[]>(
  routers: Routers,
): RootRouter<
  TRouterContract<
    MergeRoutersRoutesContracts<ExtractRouterContracts<[...Routers]>>,
    undefined
  >
> {
  const routes: Record<string, any> = {}
  for (const router of routers) {
    for (const [name, route] of Object.entries(router.routes)) {
      // Object.assign would silently drop the earlier route; hasOwn so that
      // routes named after Object.prototype members don't false-positive
      if (Object.hasOwn(routes, name))
        throw new Error(`Root router route collision: "${name}"`)
      routes[name] = route
    }
  }
  const router = createRouter({ routes })
  return Object.freeze({
    ...router,
    [kRootRouter]: true,
    [kRootRouterSources]: routers,
  }) as any
}

export type FlattenRouterContractInput<Routes extends AnyRouterContractRoutes> =
  {
    [K in keyof Routes]: Routes[K] extends TAnyRouterContract
      ? FlattenRouterContractInput<Routes[K]['routes']>
      : Routes[K] extends TAnyProcedureContract
        ? Routes[K]['input']
        : never
  }[keyof Routes]

export type FlattenRouterDecodedInput<Routes extends AnyRouterContractRoutes> =
  t.infer.decode.output<
    Extract<FlattenRouterContractInput<Routes>, BaseTypeAny>
  >

export type RouterDecodedInput<Routes extends AnyRouterRoutes> =
  FlattenRouterDecodedInput<RouterContractsFromRoutes<Routes>>

export type RouterContractDecodedInput<Contract extends TAnyRouterContract> =
  FlattenRouterDecodedInput<Contract['routes']>

export interface CreateRouterParams<Routes extends AnyRouterRoutes> {
  routes: Routes
  guards?: AnyGuard[]
  middlewares?: AnyMiddleware[]
  meta?: RouterMetaBinding<RouterDecodedInput<Routes>>[]
  hooks?: Record<string, Callback[]>
  timeout?: number
}

export interface CreateContractRouterParams<
  Contract extends TAnyRouterContract,
> {
  routes: {
    [K in keyof Contract['routes']]: Contract['routes'][K] extends TAnyRouterContract
      ? Router<Contract['routes'][K]>
      : Contract['routes'][K] extends TAnyProcedureContract
        ? AnyProcedure<Contract['routes'][K]>
        : never
  }
  guards?: AnyGuard[]
  middlewares?: AnyMiddleware[]
  meta?: RouterMetaBinding<RouterContractDecodedInput<Contract>>[]
  timeout?: number
}

export function createRouter<const Routes extends AnyRouterRoutes>(
  params: CreateRouterParams<Routes>,
): Router<RouterContractFromRoutes<Routes>> {
  const { routes, guards, middlewares, meta, timeout } = params

  const routesContracts: any = {}
  for (const [name, route] of Object.entries(routes)) {
    routesContracts[name] = route.contract
  }

  const contract = c.router({ routes: routesContracts, timeout })

  assignRouteContracts(routes, contract)

  return createContractRouter(contract, {
    routes: routes as any,
    guards,
    middlewares,
    meta,
    timeout,
  }) as any
}

export function createContractRouter<Contract extends TAnyRouterContract>(
  contract: Contract,
  params: CreateContractRouterParams<Contract>,
): Router<Contract> {
  const guards = new Set(params.guards ?? [])
  const middlewares = new Set(params.middlewares ?? [])
  const meta = Object.freeze([...(params.meta ?? [])])

  assertUniqueMetaBindings(meta, 'router config')

  return {
    contract,
    routes: params.routes,
    guards,
    middlewares,
    meta,
    timeout: params.timeout,
    [kRouter]: true,
  }
}

export const isRouter = (value: any): value is AnyRouter =>
  Boolean(value?.[kRouter])

export const isRootRouter = (value: any): value is AnyRootRouter =>
  Boolean(value?.[kRootRouter])

function assignRouteContracts(
  routes: Record<string, any>,
  contract: TAnyRouterContract,
) {
  for (const [key, routeContract] of Object.entries(contract.routes)) {
    routes[key] = { ...routes[key], contract: routeContract }
    if (IsRouterContract(routeContract))
      assignRouteContracts(routes[key].routes, routeContract)
  }
}
