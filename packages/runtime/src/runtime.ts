import { NeemataProxy } from '@nmtjs/proxy'
export { NeemataProxy }

// import type {
//   ApplicationConfig,
//   ApplicationConfigFactory,
//   ApplicationType,
// } from '@nmtjs/application'
// import type { Logger, LoggingOptions } from '@nmtjs/core'
// import { Api } from '@nmtjs/api'
// import {
//   AppInjectables,
//   ApplicationRegistry,
//   ApplicationService,
//   resolveApplicationConfig,
// } from '@nmtjs/application'
// import { Container, createLogger, Scope } from '@nmtjs/core'

// import { Registry } from './registry/index.ts'

// export interface RuntimeOptions {
//   logging?: LoggingOptions
// }

// export interface RuntimeApplicationDefinition {
//   id: string
//   type: ApplicationType
//   factory: ApplicationConfigFactory
//   workerData?: unknown
// }

// export class Runtime {
//   readonly logger: Logger
//   readonly registry: Registry
//   readonly container: Container
//   readonly lifecycleHooks: protected
//   readonly applications = new Map<string, RuntimeApplication>()

//   constructor(options: RuntimeOptions = {}) {
//     const { logging = {} } = options
//     this.logger = createLogger(logging, 'Runtime')
//     this.registry = new Registry({ logger: this.logger })
//     this.container = new Container(
//       { logger: this.logger, registry: this.registry },
//       Scope.Global,
//     )
//     this.hooks = new ApplicationHooks({
//       container: this.container,
//       registry: this.registry,
//     })
//   }

//   registerApplication(definition: RuntimeApplicationDefinition) {
//     if (this.applications.has(definition.id)) {
//       throw new Error(
//         `Application with id [${definition.id}] already registered`,
//       )
//     }
//     const application = new RuntimeApplication(
//       this,
//       definition,
//       this.logger.child({ applicationId: definition.id }),
//     )
//     this.applications.set(definition.id, application)
//     return application
//   }

//   getApplication(id: string) {
//     return this.applications.get(id)
//   }

//   listApplications() {
//     return Array.from(this.applications.values())
//   }

//   async startAll() {
//     for (const application of this.applications.values()) {
//       await application.start()
//     }
//   }

//   async stopAll() {
//     for (const application of this.applications.values()) {
//       await application.stop()
//     }
//   }
// }

// export class RuntimeApplication {
//   readonly logger: Logger
//   readonly config: ApplicationConfig
//   readonly service: ApplicationService
//   readonly appRegistry: ApplicationRegistry
//   readonly appLifecycleHooks: LifecycleHooks
//   readonly appContainer: Container
//   readonly appHooks: ApplicationHooks
//   readonly api: Api
//   readonly pubsub: PubSub
//   #initialized = false

//   constructor(
//     readonly runtime: Runtime,
//     readonly definition: RuntimeApplicationDefinition,
//     logger: Logger,
//   ) {
//     this.logger = logger
//     this.config = resolveApplicationConfig(
//       definition.factory,
//       definition.type,
//       definition.workerData,
//     ) as ApplicationConfig
//     this.service = new ApplicationService(
//       definition.id,
//       definition.type,
//       this.config,
//     )
//     this.appRegistry = new ApplicationRegistry({ logger: this.logger })
//     this.appLifecycleHooks = new LifecycleHooks()
//     this.appContainer = new Container(
//       { logger: this.logger, registry: this.appRegistry },
//       Scope.Global,
//       this.runtime.container,
//     )
//     this.appHooks = new ApplicationHooks({
//       container: this.appContainer,
//       registry: this.appRegistry,
//     })
//     this.api = new Api(
//       {
//         container: this.appContainer,
//         logger: this.logger,
//         registry: this.appRegistry,
//       },
//       this.config.api,
//     )
//     this.pubsub = new PubSub(
//       {
//         container: this.appContainer,
//         lifecycleHooks: this.appLifecycleHooks,
//         logger: this.logger,
//         registry: this.appRegistry,
//       },
//       this.config.pubsub,
//     )
//     this.appContainer.provide(AppInjectables.workerType, this.definition.type)
//     this.appContainer.provide(AppInjectables.pubsub, this.pubsub)
//   }

//   get id() {
//     return this.definition.id
//   }

//   get type() {
//     return this.definition.type
//   }

//   async initialize() {
//     if (this.#initialized) return
//     this.service.configureLifecycleHooks(this.appLifecycleHooks)
//     this.service.applyToRegistry(this.appRegistry)
//     await this.appContainer.initialize()
//     this.#initialized = true
//   }

//   async start() {
//     await this.initialize()
//   }

//   async stop() {
//     if (!this.#initialized) return
//     await this.appContainer.dispose()
//     this.appRegistry.clear()
//     this.appLifecycleHooks.removeAllHooks()
//     this.#initialized = false
//   }

//   async dispose() {
//     await this.stop()
//   }

//   async reload() {
//     await this.stop()
//     await this.initialize()
//   }

//   // get registry() {
//   //   return this.appRegistry
//   // }

//   // get container() {
//   //   return this.appContainer
//   // }

//   // get lifecycleHooks() {
//   //   return this.appLifecycleHooks
//   // }

//   // get hooks() {
//   //   return this.appHooks
//   // }
// }
