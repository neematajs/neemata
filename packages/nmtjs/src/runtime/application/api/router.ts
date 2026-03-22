import type { Callback } from '@nmtjs/common'
import type {
  TAnyProcedureContract,
  TAnyRouterContract,
  TProcedureContract,
  TRouteContract,
  TRouterContract,
} from '@nmtjs/contract'
import type { t } from '@nmtjs/type'
import type { AnyType } from '@nmtjs/type/any'
import { c, IsRouterContract } from '@nmtjs/contract'

import type { AnyGuard } from './guards.ts'
import type { AnyMiddleware } from './middlewares.ts'
import type { AnyProcedure } from './procedure.ts'
import { kRootRouter, kRouter } from './constants.ts'

export interface AnyRouter {
  contract: TAnyRouterContract
  routes: Record<string, AnyProcedure<TAnyProcedureContract> | AnyRouter>
  guards: Set<AnyGuard<any>>
  middlewares: Set<AnyMiddleware>
  timeout?: number
  [kRouter]: any
}

export interface AnyRootRouter extends AnyRouter {
  [kRootRouter]: any
  contract: TAnyRouterContract<Record<string, TRouteContract>, undefined>
  default?: AnyProcedure<any>
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
  guards: Set<AnyGuard<FlattenRouterContractInput<Contract['routes']>>>
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
  default?: AnyProcedure<any>
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

export function createRootRouter<Routers extends readonly AnyRouter[]>(
  routers: Routers,
  defaultProcedure?: AnyProcedure<
    TProcedureContract<AnyType, AnyType, true | undefined, string | undefined>
  >,
): RootRouter<
  TRouterContract<
    MergeRoutersRoutesContracts<ExtractRouterContracts<[...Routers]>>,
    undefined
  >
> {
  const routes: Record<string, any> = {}
  for (const router of routers) Object.assign(routes, router.routes)
  const router = createRouter({ routes, name: undefined })
  return Object.freeze({
    ...router,
    default: defaultProcedure,
    [kRootRouter]: true,
  }) as any
}

export type FlattenRouterInput<
  Routes extends Record<string, AnyProcedure<any> | AnyRouter>,
> = {
  [K in keyof Routes]: Routes[K] extends AnyRouter
    ? FlattenRouterInput<Routes[K]['routes']>
    : Routes[K] extends AnyProcedure
      ? Routes[K]['contract']['input']
      : never
}[keyof Routes]

export type FlattenRouterContractInput<
  Routes extends Record<string, TAnyProcedureContract | TAnyRouterContract>,
> = {
  [K in keyof Routes]: Routes[K] extends TAnyRouterContract
    ? FlattenRouterContractInput<Routes[K]['routes']>
    : Routes[K] extends TAnyProcedureContract
      ? Routes[K]['input']
      : never
}[keyof Routes]

export function createRouter<
  const Routes extends Record<string, AnyProcedure<any> | AnyRouter>,
  const Options extends {
    routes: Routes
    name?: string
    guards?: AnyGuard<
      t.infer.decode.output<FlattenRouterInput<Options['routes']>>
    >[]
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
  const { routes, name, guards, middlewares, timeout } = params

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
  }) as any
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
    guards?: AnyGuard<FlattenRouterContractInput<Contract['routes']>>[]
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
