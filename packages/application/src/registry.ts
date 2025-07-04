import type { ErrorClass } from '@nmtjs/common'
import {
  type AnyInjectable,
  type Depedency,
  type Dependant,
  getDepedencencyInjectable,
  getInjectableScope,
  type Logger,
  Scope,
} from '@nmtjs/core'
import { ProtocolRegistry } from '@nmtjs/protocol/server'
import type { AnyFilter, AnyGuard, AnyMiddleware } from './api.ts'
import type { AnyNamespace } from './namespace.ts'
import type { AnyTask } from './tasks.ts'
import type { Command } from './types.ts'

export const APP_COMMAND = Symbol('APP_COMMAND')

export class ApplicationRegistry extends ProtocolRegistry {
  readonly commands = new Map<string | symbol, Map<string, Command>>()
  readonly filters = new Map<ErrorClass, AnyFilter<ErrorClass>>()
  readonly namespaces = new Map<string, AnyNamespace>()
  readonly middlewares = new Set<AnyMiddleware>()
  readonly guards = new Set<AnyGuard>()
  readonly tasks = new Map<string, AnyTask>()

  constructor(
    protected readonly application: {
      logger: Logger
    },
  ) {
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

  registerNamespace(namespace: AnyNamespace) {
    if (typeof namespace.contract.name === 'undefined') {
      throw new Error('Namespace name is required')
    }

    if (this.namespaces.has(namespace.contract.name))
      throw new Error(
        `Namespaces ${namespace.contract.name} already registered`,
      )

    this.namespaces.set(namespace.contract.name, namespace)
    this.registerHooks(namespace.hooks)
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

    for (const filter of this.filters.values()) {
      yield filter
    }

    for (const middleware of this.middlewares.values()) {
      yield middleware
    }

    for (const guard of this.guards.values()) {
      yield guard
    }

    for (const task of this.tasks.values()) {
      yield task
    }

    for (const namespace of this.namespaces.values()) {
      for (const procedure of namespace.procedures.values()) {
        yield procedure
      }

      for (const guard of namespace.guards.values()) {
        yield guard
      }

      for (const middleware of namespace.middlewares.values()) {
        yield middleware
      }
    }
  }

  clear() {
    super.clear()

    this.commands.clear()
    this.filters.clear()
    this.tasks.clear()
    this.namespaces.clear()
    this.middlewares.clear()
    this.guards.clear()
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
  console.log('Namespaces:')
  console.table(mapToTable(registry.namespaces))
}
