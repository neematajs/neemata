import type { BaseServerFormat } from '@nmtjs/common'

import { Api } from './api.ts'
import { builtin } from './common.ts'
import { Connection, type ConnectionOptions } from './connection.ts'
import {
  Hook,
  Scope,
  WorkerType,
  kPlugin,
  kTransportPlugin,
} from './constants.ts'
import { Container } from './container.ts'
import { EventManager } from './events.ts'
import { Format } from './format.ts'
import { type Logger, type LoggingOptions, createLogger } from './logger.ts'
import type { BasePlugin, Plugin } from './plugin.ts'
import type { AnyFilter } from './procedure.ts'
import { APP_COMMAND, Registry, printRegistry } from './registry.ts'
import type { Service } from './service.ts'
import { basicSubManagerPlugin } from './subscription.ts'
import { type AnyTask, type BaseTaskExecutor, TaskRunner } from './task.ts'
import type { TransportPlugin, TransportType } from './transport.ts'
import type { ErrorClass, ExecuteFn } from './types.ts'

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
  readonly taskRunner: TaskRunner
  readonly logger: Logger
  readonly registry: Registry
  private readonly internalContainer: Container
  readonly container: Container
  readonly eventManager: EventManager
  readonly format: Format

  private readonly plugins: Array<[Plugin, any]> = []
  private readonly transportPlugins: Array<[TransportPlugin, any]> = []
  private readonly transports = new Set<TransportType>()
  private readonly connections = new Map<string, Connection>()

  constructor(readonly options: ApplicationOptions) {
    this.logger = createLogger(
      this.options.logging,
      `${this.options.type}Worker`,
    )

    this.registry = new Registry(this)
    this.eventManager = new EventManager(this)
    this.format = new Format(this.options.api.formats)

    // create unexposed container for builtin injectables, which never gets disposed
    this.internalContainer = new Container(this)

    this.internalContainer.provide(builtin.logger, this.logger)
    this.internalContainer.provide(builtin.workerType, this.options.type)
    this.internalContainer.provide(builtin.eventManager, this.eventManager)
    this.internalContainer.provide(builtin.execute, this.execute.bind(this))

    // this will be replaced in task execution
    this.internalContainer.provide(
      builtin.taskSignal,
      new AbortController().signal,
    )

    // create a global container for rest of the application
    // including transports and plugins
    this.container = this.internalContainer.createScope(Scope.Global)

    this.api = new Api(this, this.options.api)
    this.taskRunner = new TaskRunner(this, this.options.tasks)

    this.use(basicSubManagerPlugin)
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

  use<T extends BasePlugin>(
    plugin: T,
    ...args: T extends BasePlugin<any, infer O>
      ? null extends O
        ? []
        : [options: O]
      : never
  ) {
    const options = args.at(0)

    if (kPlugin in plugin) {
      this.plugins.push([plugin, options])
    } else if (kTransportPlugin in plugin) {
      this.transportPlugins.push([
        plugin as unknown as TransportPlugin,
        options,
      ])
    } else {
      throw new Error('Invalid plugin')
    }

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

  protected createContext() {
    const logger = this.logger.child({})

    const addConnection = (options: ConnectionOptions) => {
      const connection = new Connection({ ...options }, this.registry)
      this.connections.set(connection.id, connection)
      this.registry.hooks.call(
        Hook.OnConnect,
        { concurrent: false },
        connection,
      )
      return connection
    }

    const removeConnection = (connectionOrId: Connection | string) => {
      const connection =
        typeof connectionOrId === 'string'
          ? this.connections.get(connectionOrId)
          : connectionOrId
      if (connection) {
        this.registry.hooks.call(
          Hook.OnDisconnect,
          { concurrent: true },
          connection,
        )
        this.connections.delete(connection.id)
      }
    }

    const getConnection = (id: string) => {
      return this.connections.get(id)
    }

    // TODO: here might be better to come up with some interface,
    // instead of providing components directly
    return {
      type: this.options.type,
      api: this.api,
      format: this.format,
      container: this.container,
      eventManager: this.eventManager,
      logger,
      registry: this.registry,
      hooks: this.registry.hooks,
      connections: {
        get: getConnection,
        add: addConnection,
        remove: removeConnection,
      },
    }
  }
}
