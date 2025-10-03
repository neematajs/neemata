import type { Callback } from '@nmtjs/common'
import type {
  TAnyProcedureContract,
  TAnyRouterContract,
  TProcedureContract,
  TRouterContract,
} from '@nmtjs/contract'
import { c } from '@nmtjs/contract'
import { Hooks } from '@nmtjs/core'

import type { AnyGuard, AnyMiddleware } from './api.ts'
import type { AnyProcedure } from './procedure.ts'
import { kRouter } from './constants.ts'

export interface AnyRouter {
  contract: TAnyRouterContract
  routes: Record<string, AnyProcedure<any> | AnyRouter>
  guards: Set<AnyGuard>
  middlewares: Set<AnyMiddleware>
  hooks: Hooks
  timeout?: number
  [kRouter]: any
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
  hooks: Hooks
  timeout?: number
  [kRouter]: any
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
  const { name, guards, hooks, middlewares, timeout } = params
  const routes =
    params.routes ?? ({} as Record<string, AnyProcedure<any> | AnyRouter>)

  const routesContracts: any = {}
  for (const [name, route] of Object.entries(routes)) {
    routesContracts[name] = route.contract
  }

  const contract = c.router({ routes: routesContracts, timeout, name })

  for (const [name, routeContract] of Object.entries(contract.routes)) {
    // TODO: fix this
    // @ts-expect-error
    routes[name] = { timeout, ...routes[name], contract: routeContract }
  }

  const router = createContractRouter(contract, {
    routes: routes as any,
    guards,
    hooks,
    middlewares,
    timeout,
  })

  return router as any
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
    hooks?: Record<string, Callback[]>
    timeout?: number
  },
): Router<Contract> {
  const guards = new Set(params.guards ?? [])
  const middlewares = new Set(params.middlewares ?? [])
  const hooks = new Hooks()

  for (const [hookName, callbacks] of Object.entries(params.hooks ?? {})) {
    for (const hook of callbacks) {
      hooks.add(hookName, hook)
    }
  }

  return {
    contract,
    routes: params.routes,
    guards,
    middlewares,
    hooks,
    timeout: params.timeout,
    [kRouter]: true,
  }
}

export const isRouter = (value: any): value is AnyRouter =>
  Boolean(value?.[kRouter])
