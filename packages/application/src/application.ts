import type { TAnyAPIContract } from '@nmtjs/contract'
import {
  type BasePlugin,
  Container,
  createLogger,
  Hook,
  isPlugin,
  type Logger,
  type LoggingOptions,
  type Plugin,
  Scope,
} from '@nmtjs/core'
import { CoreInjectables } from '@nmtjs/core'
import {
  type BaseServerFormat,
  type Connection,
  Format,
  isTransportPlugin,
  Protocol,
  type Transport,
  type TransportPlugin,
} from '@nmtjs/protocol/server'
import { type AnyFilter, Api } from './api.ts'
import { WorkerType } from './enums.ts'
import { AppInjectables } from './injectables.ts'
import type { AnyNamespace } from './namespace.ts'
import { APP_COMMAND, ApplicationRegistry, printRegistry } from './registry.ts'
import { type AnyTask, type BaseTaskExecutor, TasksRunner } from './task.ts'
import type { ApplicationPluginContext, ExecuteFn } from './types.ts'
import type { ErrorClass } from '@nmtjs/common'

export type ApplicationOptions = {
  type: WorkerType
  api: {
    timeout: number
    formats: BaseServerFormat[]
  }
  tasks: {
    timeout: number
    executor?: BaseTaskExecutor
  }
  events?: {}
  logging?: LoggingOptions
}

type UseFn<N extends readonly [...AnyNamespace[]]> = <
  T extends BasePlugin<any, any, ApplicationPluginContext>,
>(
  plugin: T,
  ...args: T extends BasePlugin<any, infer O, ApplicationPluginContext>
    ? null extends O
      ? []
      : [options: O]
    : never
) => Application<N>

export type AnyApplication = Application<readonly [...AnyNamespace[]]>

export class Application<T extends readonly [...AnyNamespace[]] = readonly []> {
  readonly _!: { namespaces: T }
  readonly api: Api
  readonly taskRunner: TasksRunner
  readonly logger: Logger
  readonly registry: ApplicationRegistry
  protected readonly _container: Container
  readonly container: Container
  // readonly eventManager: EventManager
  readonly format: Format
  readonly protocol: Protocol
  readonly plugins: Array<[Plugin<any, any, ApplicationPluginContext>, any]> =
    []
  readonly transportPlugins: Array<[TransportPlugin, any]> = []
  readonly transports = new Set<Transport>()
  readonly connections = new Map<string, Connection>()

  constructor(readonly options: ApplicationOptions) {
    this.logger = createLogger(
      this.options.logging,
      `${this.options.type}Worker`,
    )

    this.registry = new ApplicationRegistry(this)
    this.format = new Format(this.options.api.formats)

    // create unexposed container for global injectables, which never gets disposed
    this._container = new Container(this)
    this._container.provide(CoreInjectables.logger, this.logger)
    this._container.provide(AppInjectables.workerType, this.options.type)
    this._container.provide(AppInjectables.execute, this.execute.bind(this))

    // this will be overriden in task execution
    this._container.provide(
      AppInjectables.taskAbortSignal,
      new AbortController().signal,
    )

    // create a global container for rest of the application
    // including transports and plugins
    this.container = this._container.fork(Scope.Global)

    this.api = new Api(this, this.options.api)
    this.protocol = new Protocol(this)
    this.taskRunner = new TasksRunner(this, this.options.tasks)
  }

  async initialize() {
    this.initializeEssential()
    await this.initializePlugins()
    await this.initializeTransports()
    await this.registry.hooks.call(Hook.BeforeInitialize, { concurrent: false })
    await this.container.load()
    await this.registry.hooks.call(Hook.AfterInitialize, { concurrent: false })
  }

  async start() {
    await this.initialize()

    if (this.isApiWorker) {
      await this.registry.hooks.call(Hook.BeforeStart, { concurrent: false })
      for (const transport of this.transports) await transport.start()
      await this.registry.hooks.call(Hook.AfterStart, { concurrent: false })
    }
  }

  async stop() {
    if (this.isApiWorker) {
      await this.registry.hooks.call(Hook.BeforeStop, {
        concurrent: false,
        reverse: true,
      })

      for (const transport of this.transports) await transport.stop()

      await this.registry.hooks.call(Hook.AfterStop, {
        concurrent: false,
        reverse: true,
      })
    }
    await this.terminate()
  }

  async terminate() {
    await this.registry.hooks.call(Hook.BeforeTerminate, {
      concurrent: false,
      reverse: true,
    })

    await this.container.dispose()

    await this.registry.hooks.call(Hook.AfterTerminate, {
      concurrent: false,
      reverse: true,
    })

    this.transports.clear()
    this.registry.clear()
  }

  execute: ExecuteFn = (task, ...args: any[]) => {
    return this.taskRunner.execute(task, ...args)
  }

  use: UseFn<T> = (
    plugin: BasePlugin<any, any, ApplicationPluginContext>,
    ...args: any[]
  ) => {
    const options = args.at(0)

    if (isTransportPlugin(plugin)) {
      this.transportPlugins.push([plugin, options])
    } else if (isPlugin(plugin)) {
      this.plugins.push([plugin, options])
    } else {
      throw new Error('Invalid plugin')
    }

    return this
  }

  withNamespaces<N extends readonly [...AnyNamespace[]]>(
    ...namespaces: N
  ): Application<[...T, ...N]> {
    for (const namespace of namespaces) {
      this.registry.registerNamespace(namespace)
    }
    return this as any
  }

  withTasks(...tasks: AnyTask[]) {
    for (const task of tasks) {
      this.registry.registerTask(task)
    }
    return this
  }

  withFilters(...filters: [ErrorClass, AnyFilter][]) {
    for (const [errorClass, filter] of filters) {
      this.registry.registerFilter(errorClass, filter)
    }
    return this
  }

  protected get isApiWorker() {
    return this.options.type === WorkerType.Api
  }

  protected initializeEssential() {
    const taskCommand = this.taskRunner.command.bind(this.taskRunner)
    this.registry.registerCommand(APP_COMMAND, 'task', (arg) =>
      taskCommand(arg).then(({ error }) => {
        if (error) this.logger.error(error)
      }),
    )
    this.registry.registerCommand(APP_COMMAND, 'registry', () => {
      printRegistry(this.registry)
    })
  }

  protected async initializeTransports() {
    for (const [plugin, options] of this.transportPlugins) {
      const context = this.createContext()
      context.logger.setBindings({ $group: plugin.name })
      const transport = await plugin.init(context, options)
      this.transports.add(transport)
    }
  }

  protected async initializePlugins() {
    for (const [plugin, options] of this.plugins) {
      const context = this.createContext()
      context.logger.setBindings({ $group: plugin.name })
      await plugin.init(context, options)
    }
  }

  protected createContext($group?: string): ApplicationPluginContext {
    const logger = this.logger.child({ $group })
    // TODO: here might be better to come up with some interface,
    // instead of exposing components directly
    return Object.freeze({
      type: this.options.type,
      api: this.api,
      format: this.format,
      container: this.container,
      // eventManager: this.eventManager,
      logger,
      registry: this.registry,
      hooks: this.registry.hooks,
      protocol: this.protocol,
    })
  }
}

export function createApplication(
  ...args: ConstructorParameters<typeof Application>
) {
  return new Application(...args)
}
