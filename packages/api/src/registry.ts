import type { ErrorClass } from '@nmtjs/common'
import type { AnyInjectable, Dependant, Logger } from '@nmtjs/core'
import { getInjectableScope, Scope } from '@nmtjs/core'
import { ProtocolRegistry } from '@nmtjs/protocol/server'

import type { AnyFilter, AnyGuard, AnyMiddleware } from './api.ts'
import type { AnyProcedure } from './procedure.ts'
import type { AnyRouter } from './router.ts'
import { isProcedure } from './procedure.ts'
import { isRouter } from './router.ts'

export class ApiRegistry extends ProtocolRegistry {
  readonly filters = new Map<ErrorClass, AnyFilter<ErrorClass>>()
  readonly middlewares = new Set<AnyMiddleware>()
  readonly guards = new Set<AnyGuard>()
  readonly procedures = new Map<
    string,
    { procedure: AnyProcedure; path: AnyRouter[] }
  >()
  readonly routers = new Map<string, AnyRouter>()

  registerRouter(router: AnyRouter, path: AnyRouter[] = []) {
    for (const route of Object.values(router.routes)) {
      if (isRouter(route)) {
        const name = route.contract.name!
        if (this.routers.has(name)) {
          throw new Error(`Router ${name} already registered`)
        }
        this.registerHooks(route.hooks)
        this.routers.set(name!, route)
        this.registerRouter(route, [...path, router])
      } else if (isProcedure(route)) {
        const name = route.contract.name!
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
