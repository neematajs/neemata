import type { AnyInjectable, Depedency, Dependant, Logger } from '@nmtjs/core'
import { ApiRegistry } from '@nmtjs/api'
import {
  getDepedencencyInjectable,
  getInjectableScope,
  Scope,
} from '@nmtjs/core'

import type { AnyTask } from './tasks.ts'
import type { Command } from './types.ts'

export const APP_COMMAND = Symbol('APP_COMMAND')

export class ApplicationRegistry extends ApiRegistry {
  readonly commands = new Map<string | symbol, Map<string, Command>>()
  readonly tasks = new Map<string, AnyTask>()

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

  *getDependants(): Generator<Dependant> {
    yield* super.getDependants()
    yield* this.tasks.values()
  }

  clear() {
    super.clear()
    this.commands.clear()
    this.tasks.clear()
  }
}

function scopeErrorMessage(name, scope = Scope.Global) {
  return `${name} must be a ${scope} scope (including all nested dependencies)`
}

function hasNonInvalidScopeDeps(
  injectables: AnyInjectable[],
  scope = Scope.Global,
) {
  return injectables.some((guard) => getInjectableScope(guard) !== scope)
}

// export function printRegistry(registry: ApplicationRegistry) {
//   // TODO: visualize the registry in a more readable way
//   const mapToTable = (map: Map<string, any>) => Array.from(map.keys())

//   console.log('Tasks:')
//   console.table(mapToTable(registry.tasks))
//   console.log('Procedures:')
//   console.table(mapToTable(registry.procedures))
//   console.log('Routers:')
//   console.table(mapToTable(registry.routers))
//   console.log('Commands:')
//   for (const [namespace, commands] of registry.commands) {
//     console.log(` Namespace: ${String(namespace)}`)
//     console.table(mapToTable(commands))
//   }
// }
