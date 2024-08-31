import type { BaseServerFormat } from '@nmtjs/common'
import { type AnyFilter, Api } from './api.ts'
import { Connection, type ConnectionOptions } from './connection.ts'
import { Hook, Scope, WorkerType } from './constants.ts'
import { Container } from './container.ts'
import { EventManager } from './events.ts'
import { Format } from './format.ts'
import { injectables } from './injectables.ts'
import { type Logger, type LoggingOptions, createLogger } from './logger.ts'
import type { Plugin } from './plugin.ts'
import { APP_COMMAND, Registry, printRegistry } from './registry.ts'
import type { Service } from './service.ts'
import { basicSubManagerPlugin } from './subscription.ts'
import { type AnyTask, type BaseTaskExecutor, TaskRunner } from './task.ts'
import type { ApplicationContext, ErrorClass, ExecuteFn } from './types.ts'

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

export class Application {
  readonly api: Api
  readonly tasks: TaskRunner
  readonly logger: Logger
  readonly registry: Registry
  readonly container: Container
  readonly eventManager: EventManager
  readonly format: Format

  readonly plugins = new Map<Plugin, any>()
  readonly connections = new Map<string, Connection>()

  constructor(readonly options: ApplicationOptions) {
    this.logger = createLogger(
      this.options.logging,
      `${this.options.type}Worker`,
    )

    this.registry = new Registry(this)
    this.eventManager = new EventManager(this)
    this.format = new Format(this.options.api.formats)

    // create unexposed container for internal injectables, which never gets disposed
    const container = new Container(this)

    container.provide(injectables.logger, this.logger)
    container.provide(injectables.workerType, this.options.type)
    container.provide(injectables.eventManager, this.eventManager)
    container.provide(injectables.execute, this.execute.bind(this))

    // create a global container for rest of the application
    // including transports, extensions, etc.
    this.container = container.createScope(Scope.Global)

    this.api = new Api(this, this.options.api)
    this.tasks = new TaskRunner(this, this.options.tasks)

    this.use(basicSubManagerPlugin)
  }

  async initialize() {
    this.initializeEssential()
    await this.initializePlugins()
    await this.registry.hooks.call(Hook.BeforeInitialize, { concurrent: false })
    await this.container.load()
    await this.registry.hooks.call(Hook.AfterInitialize, { concurrent: false })
  }

  async startup() {
    await this.initialize()

    if (this.isApiWorker) {
      await this.registry.hooks.call(Hook.OnStartup, { concurrent: false })
    }
  }

  async shutdown() {
    if (this.isApiWorker) {
      await this.registry.hooks.call(Hook.OnShutdown, {
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
    this.registry.clear()
    await this.registry.hooks.call(Hook.AfterTerminate, {
      concurrent: false,
      reverse: true,
    })
  }

  execute: ExecuteFn = (task, ...args: any[]) => {
    return this.tasks.execute(task, ...args)
  }

  use<T extends Plugin<any>>(
    plugin: T,
    ...args: T extends Plugin<infer O>
      ? null extends O
        ? []
        : [options: O]
      : never
  ) {
    this.plugins.set(plugin, args.at(0))
    return this
  }

  withServices(...services: Service[]) {
    for (const service of services) {
      this.registry.registerService(service)
    }
    return this
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

  private get isApiWorker() {
    return this.options.type === WorkerType.Api
  }

  private initializeEssential() {
    const taskCommand = this.tasks.command.bind(this.tasks)
    this.registry.registerCommand(APP_COMMAND, 'task', (arg) =>
      taskCommand(arg).then(({ error }) => {
        if (error) this.logger.error(error)
      }),
    )
    this.registry.registerCommand(APP_COMMAND, 'registry', () => {
      printRegistry(this.registry)
    })
  }

  private async initializePlugins() {
    for (const [plugin, options] of this.plugins.entries()) {
      const context = createExtensionContext(this)
      context.logger.setBindings({ $group: plugin.name })
      await plugin.init(context, options)
    }
  }
}

export const createExtensionContext = (
  app: Application,
): ApplicationContext => {
  const logger = app.logger.child({})

  const addConnection = (options: ConnectionOptions) => {
    const connection = new Connection({ ...options }, app.registry)
    app.connections.set(connection.id, connection)
    app.registry.hooks.call(Hook.OnConnect, { concurrent: true }, connection)
    return connection
  }

  const removeConnection = (connectionOrId: Connection | string) => {
    const connection =
      typeof connectionOrId === 'string'
        ? app.connections.get(connectionOrId)
        : connectionOrId
    if (connection) {
      app.connections.delete(connection.id)
      app.registry.hooks.call(
        Hook.OnDisconnect,
        { concurrent: true },
        connection,
      )
    }
  }

  const getConnection = (id: string) => {
    return app.connections.get(id)
  }

  // TODO: here might be better to come up with some interface,
  // instead of providing components directly
  return {
    type: app.options.type,
    api: app.api,
    format: app.format,
    container: app.container,
    eventManager: app.eventManager,
    logger,
    registry: app.registry,
    hooks: app.registry.hooks,
    connections: {
      add: addConnection,
      remove: removeConnection,
      get: getConnection,
    },
  }
}
