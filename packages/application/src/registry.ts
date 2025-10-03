import type { ErrorClass } from '@nmtjs/common'
import type { AnyInjectable, Depedency, Dependant, Logger } from '@nmtjs/core'
import {
  getDepedencencyInjectable,
  getInjectableScope,
  Scope,
} from '@nmtjs/core'
import { ProtocolRegistry } from '@nmtjs/protocol/server'

import type { AnyFilter, AnyGuard, AnyMiddleware } from './api.ts'
import type { AnyProcedure } from './procedure.ts'
import type { AnyRouter } from './router.ts'
import type { AnyTask } from './tasks.ts'
import type { Command } from './types.ts'
import { isProcedure } from './procedure.ts'
import { isRouter } from './router.ts'

export const APP_COMMAND = Symbol('APP_COMMAND')

export class ApplicationRegistry extends ProtocolRegistry {
  readonly commands = new Map<string | symbol, Map<string, Command>>()
  readonly filters = new Map<ErrorClass, AnyFilter<ErrorClass>>()
  readonly middlewares = new Set<AnyMiddleware>()
  readonly guards = new Set<AnyGuard>()
  readonly tasks = new Map<string, AnyTask>()
  readonly procedures = new Map<
    string,
    { procedure: AnyProcedure; path: AnyRouter[] }
  >()
  readonly routers = new Map<string, AnyRouter>()

  constructor(protected readonly application: { logger: Logger }) {
    super(application)
  }

  registerCommand(
    namespace: string | typeof APP_COMMAND,
    commandName: string,
    callback: Command,
  ) {
    let commands = this.commands.get(namespace)
    if (!commands) this.commands.set(namespace, (commands = new Map()))
    commands.set(commandName, callback)
  }

  registerRouter(router: AnyRouter, path: AnyRouter[] = []) {
    for (const route of Object.values(router.routes)) {
      if (isRouter(route)) {
        if (this.routers.has(route.contract.name!)) {
          throw new Error(`Router ${route.contract.name} already registered`)
        }
        this.registerHooks(route.hooks)
        this.routers.set(route.contract.name!, route)
        this.registerRouter(route, [...path, router])
      } else if (isProcedure(route)) {
        if (this.procedures.has(route.contract.name!)) {
          throw new Error(`Procedure ${route.contract.name} already registered`)
        }
        this.procedures.set(route.contract.name!, {
          procedure: route,
          path: [...path, router],
        })
      }
    }
  }

  registerTask(task: AnyTask) {
    if (this.tasks.has(task.name))
      throw new Error(`Task ${task.name} already registered`)

    if (
      hasNonInvalidScopeDeps(
        Object.values<Depedency>(task.dependencies).map(
          getDepedencencyInjectable,
        ),
      )
    )
      throw new Error(scopeErrorMessage('Task dependencies'))

    this.application.logger.debug('Registering task [%s]', task.name)
    this.tasks.set(task.name, task)
  }

  registerFilter<T extends ErrorClass>(errorClass: T, filter: AnyFilter<T>) {
    if (hasNonInvalidScopeDeps([filter]))
      throw new Error(scopeErrorMessage('Filters'))
    // TODO: should this register multiple filters for the same error class?
    // probably not, right?
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
    yield* this.tasks.values()

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
    this.commands.clear()
    this.filters.clear()
    this.tasks.clear()
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
  return injectables.some((guard) => getInjectableScope(guard) !== scope)
}

export function printRegistry(registry: ApplicationRegistry) {
  // TODO: visualize the registry in a more readable way
  const mapToTable = (map: Map<string, any>) => Array.from(map.keys())

  console.log('Tasks:')
  console.table(mapToTable(registry.tasks))
  // console.log('Namespaces:')
  // console.table(mapToTable(registry.namespaces))
}
