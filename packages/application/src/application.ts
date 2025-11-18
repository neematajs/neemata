import type { Logger } from '@nmtjs/core'
import type { Transport } from '@nmtjs/protocol/server'
import { Api, createRootRouter } from '@nmtjs/api'
import {
  ApplicationHooks,
  Container,
  CoreInjectables,
  createLogger,
  Scope,
} from '@nmtjs/core'
import { Protocol, ProtocolFormats } from '@nmtjs/protocol/server'

import type { ApplicationConfig } from './config.ts'
import type {
  ApplicationPluginContext,
  ApplicationPluginType,
} from './plugins.ts'
import { LifecycleHooks } from '../../core/src/hooks/lifecycle-hooks.ts'
import { Commands } from './commands.ts'
import { ApplicationType, LifecycleHook } from './enums.ts'
import { AppInjectables } from './injectables.ts'
import { JobRunner } from './job-runner.ts'
import { PubSub } from './pubsub.ts'
import { ApplicationRegistry } from './registry.ts'

export class Application<Config extends ApplicationConfig = ApplicationConfig> {
  protected readonly internalContainer: Container
  readonly api: Api
  // readonly commands: Commands
  readonly logger: Logger
  readonly registry: ApplicationRegistry
  readonly pubsub: PubSub
  readonly container: Container
  // readonly format: ProtocolFormats
  // readonly protocol: Protocol
  readonly hooks: ApplicationHooks
  readonly lifecycleHooks: LifecycleHooks
  // readonly jobRunner: JobRunner

  // readonly transports: Transport[] = []
  readonly plugins: ApplicationPluginType[] = []

  constructor(
    public type: ApplicationType,
    public config: Config,
  ) {
    this.logger = createLogger(this.config.logging, `${this.type}Worker`)

    this.lifecycleHooks = new LifecycleHooks()
    this.registry = new ApplicationRegistry({ logger: this.logger })

    // this.format = new ProtocolFormats(this.config.protocol.formats)

    // create unexposed container for global injectables, which never gets disposed
    this.internalContainer = new Container({
      logger: this.logger,
      registry: this.registry,
    })
    this.internalContainer.provide(CoreInjectables.logger, this.logger)
    this.internalContainer.provide(AppInjectables.workerType, this.type)

    // create a global container for rest of the application
    // including transports and plugins
    this.container = this.internalContainer.fork(Scope.Global)
    // this.jobRunner = new JobRunner({
    //   container: this.container,
    //   logger: this.logger,
    //   registry: this.registry,
    //   lifecycleHooks: this.lifecycleHooks,
    // })
    this.hooks = new ApplicationHooks({
      container: this.container,
      registry: this.registry,
    })
    this.api = new Api(
      {
        container: this.container,
        logger: this.logger,
        registry: this.registry,
      },
      this.config.api,
    )
    // this.commands = new Commands(
    //   {
    //     container: this.container,
    //     lifecycleHooks: this.lifecycleHooks,
    //     registry: this.registry,
    //   },
    //   this.config.commands.options,
    // )
    this.pubsub = new PubSub(
      {
        container: this.container,
        lifecycleHooks: this.lifecycleHooks,
        logger: this.logger,
        registry: this.registry,
      },
      this.config.pubsub,
    )
    // this.protocol = new Protocol(
    //   {
    //     api: this.api,
    //     container: this.container,
    //     hooks: this.hooks,
    //     logger: this.logger,
    //     registry: this.registry,
    //   },
    //   config.protocol,
    // )

    // this.internalContainer.provide(
    //   AppInjectables.executeCommand,
    //   this.commands.execute.bind(this.commands),
    // )
    // this.internalContainer.provide(
    //   AppInjectables.runJob,
    //   this.jobRunner.runJob.bind(this.commands),
    // )
    this.internalContainer.provide(AppInjectables.pubsub, this.pubsub)
  }

  async initialize() {
    this.logger.trace('Initializing plugins...')
    await this.initializePlugins()

    if (this.isApiWorker) {
      this.logger.trace('Initializing transports...')
      await this.initializeTransports()
    }

    await this.lifecycleHooks.callHook(LifecycleHook.InitializeBefore, this)

    this.logger.trace('Initializing essentials...')
    this.initializeCore()

    this.logger.trace('Initializing container...')
    await this.lifecycleHooks.callHook(
      LifecycleHook.ContainerInitializeBefore,
      this.container,
      this,
    )
    await this.container.initialize()
    await this.lifecycleHooks.callHook(
      LifecycleHook.ContainerInitializeAfter,
      this.container,
      this,
    )

    await this.lifecycleHooks.callHook(LifecycleHook.InitializeAfter, this)
  }

  async start() {
    this.logger.trace('Starting application...')
    await this.initialize()
    await this.lifecycleHooks.callHook(LifecycleHook.StartBefore, this)
    if (this.isApiWorker) {
      this.logger.trace('Starting transports...')
      for (const transport of this.transports) await transport.start()
    }
    await this.lifecycleHooks.callHook(LifecycleHook.StartAfter, this)
    this.logger.trace('Startup finished')
  }

  async stop() {
    this.logger.trace('Stopping application...')
    await this.lifecycleHooks.callHook(LifecycleHook.StopBefore, this)
    if (this.isApiWorker) {
      this.logger.trace('Stopping transports...')
      for (const transport of this.transports) await transport.stop()
    }
    await this.lifecycleHooks.callHook(LifecycleHook.StopAfter, this)
    await this.dispose()
    this.logger.trace('Application succesfully stopped')
  }

  async dispose() {
    this.logger.trace('Disposing application...')
    await this.lifecycleHooks.callHook(LifecycleHook.DisposeBefore, this)

    this.logger.trace('Disposing container...')
    await this.lifecycleHooks.callHook(
      LifecycleHook.ContainerDisposeBefore,
      this.container,
      this,
    )
    await this.container.dispose()
    await this.lifecycleHooks.callHook(
      LifecycleHook.ContainerDisposeAfter,
      this.container,
      this,
    )

    await this.disposePlugins()

    this.logger.trace('Clearing registry...')
    this.registry.clear()
    this.transports.length = 0
    this.plugins.length = 0

    await this.lifecycleHooks.callHook(LifecycleHook.DisposeAfter, this)
    this.logger.trace('Application disposed')
  }

  async reload() {
    this.registry.clear()
    this.lifecycleHooks.removeAllHooks()
    this.initializeCore()
    await this.protocol.reload()
  }

  initializeCore() {
    this.lifecycleHooks.addHooks(this.config.lifecycleHooks)
    const appRouter = this.config.router
    const routers = this.plugins
      .map((p) => p.router)
      .filter(Boolean) as AnyRouter[]
    if (appRouter) routers.push(appRouter)
    const rootRouter = createRootRouter(...routers)
    this.registry.registerRootRouter(rootRouter)
    for (const filter of this.config.filters) {
      this.registry.registerFilter(filter[0], filter[1])
    }
    for (const job of this.config.jobs) {
      this.registry.registerJob(job)
    }
    for (const command of this.config.commands.commands) {
      this.registry.registerCommand(command)
    }
    for (const hook of this.config.hooks) {
      this.registry.registerHook(hook)
    }
  }

  protected get isApiWorker() {
    return this.type === ApplicationType.Api
  }

  protected async initializeTransports() {
    for (const { transport, options } of this.config.transports) {
      await this.lifecycleHooks.callHook(
        LifecycleHook.TransportInitializeBefore,
        transport,
        this,
      )
      const context = this.createContext(transport.name)
      const instance = await transport.factory(context, options)
      this.transports.push(instance)
      await this.lifecycleHooks.callHook(
        LifecycleHook.TransportInitializeAfter,
        transport,
        instance,
        this,
      )
    }
  }

  protected async initializePlugins() {
    for (const { plugin, options } of this.config.plugins) {
      await this.lifecycleHooks.callHook(
        LifecycleHook.PluginInitializeBefore,
        plugin,
        this,
      )
      const context = this.createContext(plugin.name)
      let instance = await plugin.factory(context, options)
      instance = instance || {}
      if (instance.hooks) this.lifecycleHooks.addHooks(instance.hooks)
      if (instance.provide) {
        for (const [key, value] of instance.provide) {
          this.container.provide(key, value)
        }
      }
      this.plugins.push(instance)
      await this.lifecycleHooks.callHook(
        LifecycleHook.PluginInitializeAfter,
        plugin,
        instance,
        this,
      )
    }
  }

  protected async disposePlugins() {
    this.logger.trace('Disposing plugins...')
    for (let i = 0; i < this.config.plugins.length; i++) {
      const { plugin } = this.config.plugins[i]
      const instance = this.plugins[i]
      await this.lifecycleHooks.callHook(
        LifecycleHook.PluginDisposeBefore,
        plugin,
        instance,
        this,
      )
      if (instance.hooks) this.lifecycleHooks.removeHooks(instance.hooks)
      if (instance.router)
        this.registry.routers.delete(instance.router.contract.name!)
      await this.lifecycleHooks.callHook(
        LifecycleHook.PluginDisposeAfter,
        plugin,
        instance,
        this,
      )
    }
  }

  protected createContext($lable?: string): ApplicationPluginContext {
    const logger = this.logger.child({ $lable })
    // TODO: here might be better to come up with some interface,
    // instead of exposing components directly
    return Object.freeze({
      logger,
      type: this.type,
      api: this.api,
      pubsub: this.pubsub,
      format: this.format,
      container: this.container,
      registry: this.registry,
      hooks: this.hooks,
      protocol: this.protocol,
      lifecycleHooks: this.lifecycleHooks,
    })
  }
}

export function createApplication<Config extends ApplicationConfig>(
  type: ApplicationType,
  config: Config,
): Application<Config> {
  return new Application(type, config)
}
