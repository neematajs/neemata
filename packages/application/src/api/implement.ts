import type {
  TAnyProcedureContract,
  TAnyRouterContract,
  TRouteContract,
} from '@nmtjs/contract'
import type { Dependencies } from '@nmtjs/core'
import { IsProcedureContract, IsRouterContract } from '@nmtjs/contract'

import type { CreateProcedureParams, Procedure } from './procedure.ts'
import type {
  CreateContractRouterParams,
  RootRouter,
  Router,
} from './router.ts'
import { kRootRouter, kRootRouterSources } from './constants.ts'
import { createContractProcedure } from './procedure.ts'
import { createContractRouter } from './router.ts'

export type ProcedureImplementer<Contract extends TAnyProcedureContract> = <
  Deps extends Dependencies,
>(
  paramsOrHandler: CreateProcedureParams<Contract, Deps>,
) => Procedure<Contract, Deps>

export type RouterImplementer<
  Contract extends TAnyRouterContract,
  IsRoot extends boolean = false,
> = ((
  routes: ImplementedRoutes<Contract>,
  params?: ImplementRouterParams<Contract>,
) => Router<Contract> & (IsRoot extends true ? RootRouter<any> : unknown)) & {
  readonly [K in keyof Contract['routes']]: RouteImplementer<
    Contract['routes'][K]
  >
}

export type RouteImplementer<Contract extends TRouteContract> =
  Contract extends TAnyRouterContract
    ? RouterImplementer<Contract>
    : Contract extends TAnyProcedureContract
      ? ProcedureImplementer<Contract>
      : never

export type ImplementedRoutes<Contract extends TAnyRouterContract> = {
  [K in keyof Contract['routes']]: Contract['routes'][K] extends TAnyRouterContract
    ? Router<Contract['routes'][K]>
    : Contract['routes'][K] extends TAnyProcedureContract
      ? Procedure<Contract['routes'][K], any>
      : never
}

export type ImplementRouterParams<Contract extends TAnyRouterContract> = Omit<
  CreateContractRouterParams<Contract>,
  'routes'
>

export function implement<Contract extends TAnyRouterContract>(
  contract: Contract,
): RouterImplementer<Contract, true>
export function implement<Contract extends TAnyProcedureContract>(
  contract: Contract,
): ProcedureImplementer<Contract>
export function implement(
  contract: TAnyRouterContract | TAnyProcedureContract,
): RouterImplementer<any, true> | ProcedureImplementer<any> {
  return createImplementer(contract, true) as any
}

function createImplementer(
  contract: TAnyRouterContract | TAnyProcedureContract,
  isRoot: boolean,
) {
  if (IsProcedureContract(contract)) {
    return (paramsOrHandler: CreateProcedureParams<any, any>) =>
      createContractProcedure(contract, paramsOrHandler)
  }

  if (!IsRouterContract(contract)) throw new Error('Invalid contract')

  const builder = (
    routes: ImplementedRoutes<any>,
    params: ImplementRouterParams<any> = {},
  ) => {
    validateRoutes(contract, routes)
    const router = createContractRouter(
      contract as any,
      { ...params, routes } as any,
    )
    return isRoot ? createRootRouter(router) : router
  }

  for (const [routeName, routeContract] of Object.entries(contract.routes)) {
    Object.defineProperty(builder, routeName, {
      value: createImplementer(routeContract, false),
      enumerable: true,
      configurable: true,
    })
  }

  return Object.freeze(builder)
}

function createRootRouter<Contract extends TAnyRouterContract>(
  router: Router<Contract>,
): Router<Contract> & RootRouter<any> {
  return Object.freeze({
    ...router,
    [kRootRouter]: true,
    [kRootRouterSources]: [router],
  }) as Router<Contract> & RootRouter<any>
}

function validateRoutes(
  contract: TAnyRouterContract,
  routes: Record<string, any>,
) {
  const expectedKeys = new Set(Object.keys(contract.routes))

  for (const routeName of expectedKeys) {
    if (!Object.hasOwn(routes, routeName)) {
      throw new Error(`Missing implementation for route [${routeName}]`)
    }
  }

  for (const routeName of Object.keys(routes)) {
    if (!expectedKeys.has(routeName)) {
      throw new Error(`Unknown implementation route [${routeName}]`)
    }
  }

  for (const [routeName, routeContract] of Object.entries(contract.routes)) {
    if (routes[routeName]?.contract !== routeContract) {
      throw new Error(
        `Implementation for route [${routeName}] does not match contract`,
      )
    }
  }
}
