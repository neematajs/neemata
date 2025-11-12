import type { ErrorClass } from '@nmtjs/common'
import type { AnyInjectable, Dependant } from '@nmtjs/core'
import { getInjectableScope, Registry, Scope } from '@nmtjs/core'

import type { AnyFilter, AnyGuard, AnyMiddleware } from './api.ts'
import type { AnyProcedure } from './procedure.ts'
import type { AnyRouter } from './router.ts'
import { kRootRouter } from './constants.ts'
import { isProcedure } from './procedure.ts'
import { isRootRouter, isRouter } from './router.ts'

export class ApiRegistry extends Registry {
  readonly filters = new Map<ErrorClass, AnyFilter<ErrorClass>>()
  readonly middlewares = new Set<AnyMiddleware>()
  readonly guards = new Set<AnyGuard>()
  readonly procedures = new Map<
    string,
    { procedure: AnyProcedure; path: AnyRouter[] }
  >()
  readonly routers = new Map<string | kRootRouter, AnyRouter>()

  registerRootRouter(router: AnyRouter) {
    if (this.routers.has(kRootRouter)) {
      throw new Error('Root router already registered')
    }

    if (!isRootRouter(router)) {
      throw new Error('Root router must be a root router')
    }

    this.routers.set(kRootRouter, router)
    this.registerRouter(router, [])
  }

  registerRouter(router: AnyRouter, path: AnyRouter[] = []) {
    for (const route of Object.values(router.routes)) {
      if (isRouter(route)) {
        const name = path.length === 0 ? kRootRouter : route.contract.name
        if (!name) throw new Error('Nested routers must have a name')
        if (this.routers.has(name)) {
          throw new Error(`Router ${String(name)} already registered`)
        }
        this.routers.set(name, route)
        this.registerRouter(route, [...path, router])
      } else if (isProcedure(route)) {
        const name = route.contract.name
        if (!name) throw new Error('Procedures must have a name')
        if (this.procedures.has(name)) {
          throw new Error(`Procedure ${name} already registered`)
        }
        this.procedures.set(name, { procedure: route, path: [...path, router] })
      }
    }
  }

  registerFilter<T extends ErrorClass>(errorClass: T, filter: AnyFilter<T>) {
    if (hasNonInvalidScopeDeps([filter]))
      throw new Error(scopeErrorMessage('Filters'))
    this.filters.set(errorClass, filter)
  }

  registerMiddleware(middleware: AnyMiddleware) {
    if (hasNonInvalidScopeDeps([middleware]))
      throw new Error(scopeErrorMessage('Middleware'))
    this.middlewares.add(middleware)
  }

  registerGuard(guard: AnyGuard) {
    if (hasNonInvalidScopeDeps([guard]))
      throw new Error(scopeErrorMessage('Guard'))
    this.guards.add(guard)
  }

  *getDependants(): Generator<Dependant> {
    yield* super.getDependants()

    yield* this.filters.values()
    yield* this.middlewares.values()
    yield* this.guards.values()

    for (const { procedure } of this.procedures.values()) {
      yield* procedure.guards.values()
      yield* procedure.middlewares.values()
      yield procedure
    }

    for (const router of this.routers.values()) {
      yield* router.guards.values()
      yield* router.middlewares.values()
    }
  }

  clear() {
    super.clear()
    this.filters.clear()
    this.middlewares.clear()
    this.guards.clear()
    this.routers.clear()
    this.procedures.clear()
  }
}

export const scopeErrorMessage = (name, scope = Scope.Global) =>
  `${name} must be a ${scope} scope (including all nested dependencies)`

export function hasNonInvalidScopeDeps(
  injectables: AnyInjectable[],
  scope = Scope.Global,
) {
  return hasInvalidScopeDeps(injectables, scope)
}

function hasInvalidScopeDeps(
  injectables: AnyInjectable[],
  scope = Scope.Global,
) {
  return injectables.some(
    (injectable) => getInjectableScope(injectable) !== scope,
  )
}
