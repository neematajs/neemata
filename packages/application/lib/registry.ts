import type { TProcedureContract, TSubscriptionContract } from '@nmtjs/contract'
import type { BaseType } from '@nmtjs/type'
import { type Compiled, compile } from '@nmtjs/type/compiler'

import type { AnyFilter, Filter } from './api.ts'
import { type Hook, Scope } from './constants.ts'
import {
  type AnyProvider,
  type Depedency,
  getDepedencencyProvider,
  getProviderScope,
} from './container.ts'
import { Hooks } from './hooks.ts'
import type { Logger } from './logger.ts'
import type { AnyService } from './service.ts'
import type { AnyTask } from './task.ts'
import type { Command, ErrorClass, HooksInterface } from './types.ts'

export const APP_COMMAND = Symbol('APP_COMMAND')

export class Registry {
  readonly commands = new Map<string | symbol, Map<string, Command>>()
  readonly filters = new Map<ErrorClass, AnyFilter<ErrorClass>>()
  readonly services = new Map<string, AnyService>()
  readonly schemas = new Map<any, Compiled>()
  readonly tasks = new Map<string, AnyTask>()
  readonly hooks = new Hooks()

  constructor(
    protected readonly application: {
      logger: Logger
    },
  ) {}

  registerHooks<T extends Hooks>(hooks: T) {
    Hooks.merge(hooks, this.hooks)
  }

  registerHook<T extends Hook>(name: T, callback: HooksInterface[T]) {
    this.hooks.add(name, callback)
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

  registerService(service: AnyService) {
    if (this.services.has(service.contract.name))
      throw new Error(`Service ${service.contract.name} already registered`)

    const schemas: BaseType[] = []

    for (const procedure of Object.values<
      TSubscriptionContract | TProcedureContract
    >(service.contract.procedures)) {
      schemas.push(procedure.input)
      schemas.push(procedure.output)

      if (procedure.type === 'neemata:subscription') {
        for (const event of Object.values(procedure.events)) {
          schemas.push(event.payload)
        }
      }
    }

    for (const event of Object.values(service.contract.events)) {
      schemas.push(event.payload)
    }

    for (const schema of schemas) {
      if (!schema) continue
      if (this.schemas.has(schema)) continue
      this.schemas.set(schema, compile(schema))
    }

    this.services.set(service.contract.name, service)
    this.registerHooks(service.hooks)
  }

  registerTask(task: AnyTask) {
    if (!task.name) throw new Error('Task name is not defined')

    if (this.tasks.has(task.name))
      throw new Error(`Task ${task.name} already registered`)

    if (typeof task.handler !== 'function')
      throw new Error('Task handler is not defined or is not a function')

    if (
      hasNonInvalidScopeDeps(
        Object.values<Depedency>(task.dependencies).map(
          getDepedencencyProvider,
        ),
      )
    )
      throw new Error(scopeErrorMessage('Task dependencies'))

    this.application.logger.debug('Registering task [%s]', task.name)
    this.tasks.set(task.name, task)
  }

  registerFilter<T extends ErrorClass>(errorClass: T, filter: Filter<T>) {
    if (hasNonInvalidScopeDeps([filter]))
      throw new Error(scopeErrorMessage('Filters'))
    // TODO: should this register multiple filters for the same error class?
    this.filters.set(errorClass, filter)
  }

  clear() {
    this.hooks.clear()
    this.commands.clear()
    this.filters.clear()
  }
}

export const scopeErrorMessage = (name, scope = Scope.Global) =>
  `${name} must be a ${scope} scope (including all nested dependencies)`

export function hasNonInvalidScopeDeps(
  providers: AnyProvider[],
  scope = Scope.Global,
) {
  return providers.some((guard) => getProviderScope(guard) !== scope)
}

export function printRegistry(registry: Registry) {
  const mapToTable = (map: Map<string, any>) => Array.from(map.keys())

  console.log('Tasks:')
  console.table(mapToTable(registry.tasks))
  console.log('Services:')
  console.table(mapToTable(registry.services))
  // console.log('Events:')
  // console.table(mapToTable(registry.events))
}
