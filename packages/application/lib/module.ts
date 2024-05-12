import type { Container } from './container'
import type { Hooks } from './hooks'
import type { Logger } from './logger'
import type {
  AnyEvent,
  AnyModule,
  AnyProcedure,
  AnyProvider,
  AnyTask,
  Command,
  Merge,
} from './types'
import { merge } from './utils/functions'

export type ModuleInitializerOptions = {
  container: Container
  hooks: Hooks
  logger: Logger
}

export type ModuleInitializer<Args extends any[] = []> = (
  options: ModuleInitializerOptions,
  ...args: Args
) => any

export class Module<
  ModuleOptions extends any[] = [],
  ModuleProcedures extends Record<string, AnyProcedure> = {},
  ModuleTasks extends Record<string, AnyTask> = {},
  ModuleEvents extends Record<string, AnyEvent> = {},
  ModuleImports extends Record<string, AnyModule> = {},
  O extends {
    [K in keyof ModuleOptions]: ModuleOptions[K] | AnyProvider<ModuleOptions[K]>
  } = {
    [K in keyof ModuleOptions]: ModuleOptions[K] | AnyProvider<ModuleOptions[K]>
  },
> {
  initializer?: ModuleInitializer<ModuleOptions>
  imports = {} as ModuleImports
  procedures = {} as ModuleProcedures
  tasks = {} as ModuleTasks
  events = {} as ModuleEvents
  commands = {} as Record<string, Command>
  options!: O

  constructor(...options: O) {
    this.options = options
  }

  withInitializer(initializer: ModuleInitializer<ModuleOptions>) {
    if (this.initializer) {
      const previousInitializer = this.initializer
      this.initializer = async (...args) => {
        await previousInitializer(...args)
        await initializer(...args)
      }
    } else {
      this.initializer = initializer
    }

    return this
  }

  withProcedures<NewProcedures extends Record<string, AnyProcedure>>(
    procedures: NewProcedures,
  ) {
    this.procedures = merge(this.procedures, procedures)
    return this as unknown as Module<
      ModuleOptions,
      Merge<ModuleProcedures, NewProcedures>,
      ModuleTasks,
      ModuleEvents,
      ModuleImports
    >
  }

  withTasks<NewTasks extends Record<string, AnyTask>>(tasks: NewTasks) {
    this.tasks = merge(this.tasks, tasks)
    return this as unknown as Module<
      ModuleOptions,
      ModuleProcedures,
      Merge<ModuleTasks, NewTasks>,
      ModuleEvents,
      ModuleImports
    >
  }

  withEvents<NewEvents extends Record<string, AnyEvent>>(events: NewEvents) {
    this.events = merge(this.events, events)
    return this as unknown as Module<
      ModuleOptions,
      ModuleProcedures,
      ModuleTasks,
      Merge<ModuleEvents, NewEvents>,
      ModuleImports
    >
  }

  withCommand(command: string, callback: Command) {
    if (this.commands[command]) throw new Error('Command already set')
    this.commands[command] = callback
    return this
  }

  withImports<T extends Record<string, AnyModule>>(modules: T) {
    this.imports = merge(this.imports, modules)
    return this as unknown as Module<
      ModuleOptions,
      ModuleProcedures,
      ModuleTasks,
      ModuleEvents,
      Merge<ModuleImports, T>
    >
  }
}
