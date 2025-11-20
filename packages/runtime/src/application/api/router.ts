import type { Callback } from '@nmtjs/common'
import type {
  TAnyProcedureContract,
  TAnyRouterContract,
  TProcedureContract,
  TRouteContract,
  TRouterContract,
} from '@nmtjs/contract'
import { c, IsRouterContract } from '@nmtjs/contract'

import type { AnyGuard } from './guards.ts'
import type { AnyMiddleware } from './middlewares.ts'
import type { AnyProcedure } from './procedure.ts'
import { kRootRouter, kRouter } from './constants.ts'

export interface AnyRouter {
  contract: TAnyRouterContract
  routes: Record<string, AnyProcedure<any> | AnyRouter>
  guards: Set<AnyGuard>
  middlewares: Set<AnyMiddleware>
  timeout?: number
  [kRouter]: any
}

export interface AnyRootRouter extends AnyRouter {
  [kRootRouter]: any
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
  : {}

export type ExtractRouterContracts<
  Routers extends readonly { contract: TAnyRouterContract }[],
> = Routers extends [
  infer First extends { contract: TAnyRouterContract },
  ...infer Rest extends { contract: TAnyRouterContract }[],
]
  ? [First['contract'], ...ExtractRouterContracts<Rest>]
  : []

export function createRootRouter<Routers extends readonly AnyRouter[]>(
  ...routers: Routers
): RootRouter<
  TRouterContract<
    MergeRoutersRoutesContracts<ExtractRouterContracts<Routers>>,
    undefined
  >
> {
  const routes: Record<string, any> = {}
  for (const router of routers) Object.assign(routes, router.routes)
  const router = createRouter({ name: undefined, routes: routes })
  return Object.freeze({ ...router, [kRootRouter]: true }) as any
}

export function createRouter<
  const Options extends {
    name?: string
    routes?: Record<string, AnyProcedure<any> | AnyRouter>
    guards?: AnyGuard[]
    middlewares?: AnyMiddleware[]
    hooks?: Record<string, Callback[]>
    timeout?: number
  },
>(
  params: Options,
): Router<
  TRouterContract<
    Options['routes'] extends Record<string, AnyProcedure<any> | AnyRouter>
      ? {
          [K in keyof Options['routes']]: Options['routes'][K] extends AnyRouter
            ? Options['routes'][K]['contract']
            : Options['routes'][K] extends AnyProcedure<any>
              ? Options['routes'][K]['contract']
              : never
        }
      : {},
    null extends Options['name'] ? undefined : Options['name']
  >
> {
  const { name, guards, middlewares, timeout } = params
  const routes: Record<string, any> = params.routes || {}

  const routesContracts: any = {}
  for (const [name, route] of Object.entries(routes)) {
    routesContracts[name] = route.contract
  }

  const contract = c.router({ routes: routesContracts, timeout, name })

  assignRouteContracts(routes, contract)

  return createContractRouter(contract, {
    routes: routes as any,
    guards,
    middlewares,
    timeout,
  })
}

export function createContractRouter<Contract extends TAnyRouterContract>(
  contract: Contract,
  params: {
    routes: {
      [K in keyof Contract['routes']]: Contract['routes'][K] extends TAnyRouterContract
        ? Router<Contract['routes'][K]>
        : Contract['routes'][K] extends TAnyProcedureContract
          ? AnyProcedure<Contract['routes'][K]>
          : never
    }
    guards?: AnyGuard[]
    middlewares?: AnyMiddleware[]
    timeout?: number
  },
): Router<Contract> {
  const guards = new Set(params.guards ?? [])
  const middlewares = new Set(params.middlewares ?? [])

  return {
    contract,
    routes: params.routes,
    guards,
    middlewares,
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
