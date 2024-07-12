import { type Compiled, compile } from '@neematajs/contract/compiler'
import { ContractGuard } from '@neematajs/contract/guards'
import type { Filter } from './api'
import { Scope } from './constants'
import { type Provider, getProviderScope } from './container'
import { Hooks } from './hooks'
import type { Logger } from './logger'
import type { Service } from './service'
import type { AnyTask, Command, ErrorClass } from './types'

export const APP_COMMAND = Symbol('APP_COMMAND')

export class Registry {
  readonly commands = new Map<string | symbol, Map<string, Command>>()
  readonly filters = new Map<ErrorClass, Filter<ErrorClass>>()
  readonly services = new Map<string, Service>()
  readonly schemas = new Map<any, Compiled>()
  readonly tasks = new Map<string, any>()
  readonly hooks = new Hooks()

  constructor(
    protected readonly application: {
      logger: Logger
    },
  ) {}

  async load() {
    for (const service of this.services.values()) {
      this.registerHooks(service.hooks)

      const schemas = [
        ...Object.values(service.contract.procedures).flatMap((p) => {
          return ContractGuard.IsSubscription(p.output)
            ? Object.values(p.output.events)
            : [p.output]
        }),
        ...Object.values(service.contract.procedures).map((p) => p.input),
        ...Object.values(service.contract.events).map((e) => e.payload),
      ]

      for (const schema of schemas) {
        if (!schema) continue
        if (this.schemas.has(schema)) continue
        this.schemas.set(schema, compile(schema))
      }
    }
  }

  registerHooks<T extends Hooks>(hooks: T) {
    Hooks.merge(hooks, this.hooks)
  }

  registerCommand(
    moduleName: string | typeof APP_COMMAND,
    commandName: string,
    callback: Command,
  ) {
    let commands = this.commands.get(moduleName)
    if (!commands) this.commands.set(moduleName, (commands = new Map()))
    commands.set(commandName, callback)
  }

  registerService(service: Service) {
    if (this.services.has(service.contract.name))
      throw new Error(`Service ${service.contract.name} already registered`)
    this.services.set(service.contract.name, service)
  }

  registerTask(task: AnyTask) {
    if (!task.name) throw new Error('Task name is not defined')

    if (this.tasks.has(task.name))
      throw new Error(`Task ${task.name} already registered`)

    if (typeof task.handler !== 'function')
      throw new Error('Task handler is not defined or is not a function')

    if (hasNonInvalidScopeDeps(Object.values(task.dependencies)))
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

export const hasNonInvalidScopeDeps = (
  providers: Provider[],
  scope = Scope.Global,
) => providers.some((guard) => getProviderScope(guard) !== scope)

export const printRegistry = (registry: Registry) => {
  const mapToTable = (map: Map<string, any>) => Array.from(map.keys())

  console.log('Tasks:')
  console.table(mapToTable(registry.tasks))
  console.log('Services:')
  console.table(mapToTable(registry.services))
  // console.log('Events:')
  // console.table(mapToTable(registry.events))
}
