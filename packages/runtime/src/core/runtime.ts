import type {
  AnyInjectable,
  Dependant,
  Logger,
  LoggingOptions,
} from '@nmtjs/core'
import {
  Container,
  createLogger,
  getDepedencencyInjectable,
  Scope,
} from '@nmtjs/core'

import type { RuntimePlugin } from './plugin.ts'
import { LifecycleHook } from '../enums.ts'
import { LifecycleHooks } from './hooks.ts'

export type BaseRuntimeOptions = {
  logger?: LoggingOptions
  container?: Container
  plugins?: RuntimePlugin[]
  name?: string
}

export abstract class BaseRuntime {
  logger: Logger
  container: Container
  lifecycleHooks: LifecycleHooks
  plugins: RuntimePlugin[]

  constructor(options: BaseRuntimeOptions = {}) {
    this.logger = createLogger(options.logger, options.name || 'Runtime')
    this.container = options.container
      ? options.container.fork(Scope.Global)
      : new Container({ logger: this.logger })
    this.lifecycleHooks = new LifecycleHooks()
    this.plugins = options.plugins || []
  }

  protected abstract _initialize(): Promise<void>
  protected abstract _dispose(): Promise<void>
  protected abstract _dependents(): Generator<Dependant>

  async reload(...args: any[]): Promise<void> {
    await this._dispose()
    await this._initialize()
  }

  async initialize() {
    this.logger.debug('Initializing a runtime...')
    await this._initializePlugins()
    await this._initializeContainer()
    await this.lifecycleHooks.callHook(LifecycleHook.BeforeInitialize, this)
    await this._initialize()
    await this.lifecycleHooks.callHook(LifecycleHook.AfterInitialize, this)
    this.logger.debug('Runtime initialized')
  }

  async dispose() {
    this.logger.debug('Disposing a runtime...')
    await this.lifecycleHooks.callHook(LifecycleHook.BeforeDispose, this)
    await this._dispose()
    await this.lifecycleHooks.callHook(LifecycleHook.AfterDispose, this)
    await this._disposeContainer()
    await this._disposePlugins()
    this.logger.debug('Runtime disposed')
  }

  protected async _initializePlugins() {
    if (!this.plugins?.length) return
    for (const { name, hooks, injections } of this.plugins) {
      this.logger.debug(`Initializing plugin [${name}]...`)
      if (injections) {
        for (const injection of injections) {
          await this.container.provide(injection.token, injection.value)
        }
      }
      if (hooks) this.lifecycleHooks.addHooks(hooks)
    }
  }

  protected async _disposePlugins() {
    if (!this.plugins?.length) return
    for (const { name, hooks, injections } of this.plugins) {
      this.logger.debug(`Disposing plugin [${name}]...`)
      if (hooks) this.lifecycleHooks.removeHooks(hooks)
      if (injections) {
        for (const injection of injections) {
          await this.container.disposeInjectableInstances(injection.token)
        }
      }
    }
  }

  protected async _initializeContainer() {
    const dependents = this._dependents()
    const dependencies = new Set<AnyInjectable>()
    for (const dependant of dependents) {
      for (const dependency of Object.values(dependant.dependencies)) {
        dependencies.add(getDepedencencyInjectable(dependency))
      }
    }
    await this.container.initialize(dependencies)
  }

  protected async _disposeContainer() {
    await this.container.dispose()
  }
}
