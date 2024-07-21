import { StreamDataType } from '@neematajs/common'
import type {
  TProcedureContract,
  TSchema,
  TSubscriptionContract,
} from '@neematajs/contract'
import { type Compiled, compile } from '@neematajs/contract/compiler'
import { ContractGuard } from '@neematajs/contract/guards'
import type { Filter } from './api.ts'
import { Scope } from './constants.ts'
import { type Provider, getProviderScope } from './container.ts'
import { Hooks } from './hooks.ts'
import type { Logger } from './logger.ts'
import type { Service } from './service.ts'
import type { AnyTask, Command, ErrorClass } from './types.ts'

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

    const schemas: TSchema[] = []

    for (const procedure of Object.values<
      TSubscriptionContract | TProcedureContract
    >(service.contract.procedures)) {
      if (ContractGuard.IsSubscription(procedure)) {
        schemas.push(procedure.output)
        for (const event of Object.values(procedure.events)) {
          schemas.push(event.payload)
        }
      } else if (ContractGuard.IsDownStream(procedure.output)) {
        schemas.push(procedure.output.payload)
        if (procedure.output.dataType === StreamDataType.Encoded) {
          schemas.push(procedure.output.chunk!)
        }
      } else {
        schemas.push(procedure.output)
      }

      schemas.push(procedure.input)
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
