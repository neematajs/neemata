import type { Logger } from '@nmtjs/core'
import { createLogger } from '@nmtjs/core'

import type { NeemCommandDefinition } from '../commands.ts'
import type { NeemServerPlugin } from '../plugins.ts'
import type { NeemServerConfig } from './config.ts'
import type { ErrorPolicy } from './error-policy.ts'
import type { ManagedWorkerConfig } from './managed-worker.ts'
import type { NeemServerRunOptions, NeemServerWorkerConfig } from './types.ts'
import type {
  ManagedWorkerFactory,
  WorkerPoolConfig,
  WorkerPoolFactory,
} from './worker-pool.ts'
import { ApplicationServerApplications } from './applications.ts'
import { getErrorPolicy } from './error-policy.ts'
import { ManagedWorker } from './managed-worker.ts'
import { ApplicationServerProxy } from './proxy.ts'
import { WorkerPool } from './worker-pool.ts'

/**
 * Default factory for creating ManagedWorker instances.
 */
export const defaultWorkerFactory: ManagedWorkerFactory = (
  config: ManagedWorkerConfig,
  policy: ErrorPolicy,
  logger: Logger,
) => new ManagedWorker(config, policy, logger)

/**
 * Default factory for creating WorkerPool instances.
 */
export const defaultPoolFactory: WorkerPoolFactory = (
  config: WorkerPoolConfig,
  policy: ErrorPolicy,
  workerFactory: ManagedWorkerFactory,
  logger: Logger,
) => new WorkerPool(config, policy, workerFactory, logger)

/**
 * NeemServer is the framework-agnostic application server orchestrator.
 *
 * It manages:
 * - Application worker pools
 * - Reverse proxy
 * - Plugin lifecycle/capabilities
 */
export class NeemServer {
  logger: Logger
  applications?: ApplicationServerApplications
  proxy?: ApplicationServerProxy

  protected readonly activePlugins = new Set<NeemServerPlugin>()

  get commands(): NeemCommandDefinition[] {
    return this.config.commands ?? []
  }

  getCommand(name: string): NeemCommandDefinition | undefined {
    return this.commands.find((command) => command.name === name)
  }

  constructor(
    readonly config: NeemServerConfig,
    readonly applicationsConfig: Record<string, { specifier: string }>,
    readonly workerConfig: NeemServerWorkerConfig,
    readonly runOptions: NeemServerRunOptions = {
      applications: Object.keys(config.applications),
    },
    readonly mode: 'development' | 'production' = 'development',
    readonly errorPolicy: ErrorPolicy = getErrorPolicy(mode),
    readonly workerFactory: ManagedWorkerFactory = defaultWorkerFactory,
    readonly poolFactory: WorkerPoolFactory = defaultPoolFactory,
  ) {
    this.logger = createLogger(config.logger, 'NeemServer')
    this.logger.trace(
      { applications: applicationsConfig, workerConfig, runOptions },
      'NeemServer initialized',
    )
  }

  async start() {
    const { logger, errorPolicy, workerFactory, poolFactory } = this

    logger.info('Starting neem application server...')
    await this.setupPlugins()

    this.applications = new ApplicationServerApplications({
      logger: this.logger,
      workerConfig: this.workerConfig,
      serverConfig: this.config,
      applicationsConfig: this.applicationsConfig,
      applications: this.runOptions.applications,
      errorPolicy,
      workerFactory,
      poolFactory,
    })

    if (this.config.proxy) {
      this.logger.debug('Proxy configuration detected, creating proxy...')
      this.proxy = new ApplicationServerProxy({
        logger: this.logger,
        config: this.config.proxy,
        applications: this.applications,
      })
    }

    await this.applications.start()

    if (this.proxy) {
      logger.info('Starting proxy server...')
      await this.proxy.start()
      logger.debug('Proxy server started')
    }

    logger.info('Neem application server started')
  }

  async stop() {
    this.logger.info('Stopping neem application server...')

    if (this.proxy) {
      this.logger.info('Stopping proxy server...')
      await this.proxy.stop()
      this.logger.debug('Proxy server stopped')
    }

    if (this.applications) {
      this.logger.info('Stopping applications...')
      await this.applications.stop()
      this.logger.debug('Applications stopped')
    }

    await this.disposePlugins()
    this.logger.info('Neem application server stopped')
  }

  async restartFailedWorkers(): Promise<number> {
    return (await this.applications?.restartFailedWorkers()) ?? 0
  }

  protected async setupPlugins() {
    const plugins = this.config.plugins ?? []
    for (const plugin of plugins) {
      this.logger.debug({ plugin: plugin.name }, 'Initializing plugin')
      await plugin.hooks?.['server:setup']?.({ mode: this.mode })
      this.activePlugins.add(plugin)
    }

    for (const plugin of this.activePlugins) {
      await plugin.hooks?.['server:start']?.({ mode: this.mode })
    }
  }

  protected async disposePlugins() {
    const plugins = Array.from(this.activePlugins).reverse()

    for (const plugin of plugins) {
      await plugin.hooks?.['server:stop']?.({ mode: this.mode })
      await plugin.hooks?.['server:dispose']?.({ mode: this.mode })
      this.activePlugins.delete(plugin)
      this.logger.debug({ plugin: plugin.name }, 'Plugin disposed')
    }
  }
}
