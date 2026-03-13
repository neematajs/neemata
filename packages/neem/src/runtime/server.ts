import type { Logger } from '@nmtjs/core'
import { createLogger } from '@nmtjs/core'

import type {
  NeemPoolEnvironmentOrchestrator,
  NeemServerRunOptions,
  NeemServerWorkerConfig,
} from '../types.ts'
import type { NeemApplicationConfig, NeemServerConfig } from './config.ts'
import type { ErrorPolicy } from './error-policy.ts'
import type { ManagedWorkerConfig } from './managed-worker.ts'
import type {
  NeemPluginWorkerSpawnOptions,
  NeemServerPlugin,
  NeemServerPluginContext,
  NeemServerPluginWorkerHandle,
  NeemServerPluginWorkerSnapshot,
} from './plugins.ts'
import type {
  ManagedWorkerFactory,
  WorkerPoolConfig,
  WorkerPoolFactory,
} from './worker-pool.ts'
import { ApplicationServerApplications } from './applications.ts'
import { WorkerType } from './enums.ts'
import { getErrorPolicy } from './error-policy.ts'
import { ManagedWorker } from './managed-worker.ts'
import { NeemServerPluginHooks } from './plugins.ts'
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
  protected readonly mode: 'development' | 'production'
  protected readonly errorPolicy: ErrorPolicy
  protected readonly workerFactory: ManagedWorkerFactory
  protected readonly poolFactory: WorkerPoolFactory
  protected readonly runApplications: string[]

  protected readonly pluginRuntimes: Array<{
    plugin: NeemServerPlugin
    instanceId: number
    poolName: string
    pool: WorkerPool
    hooks: NeemServerPluginHooks
    workers: Map<
      string,
      { worker: ManagedWorker; handle: NeemServerPluginWorkerHandle }
    >
  }> = []

  constructor(
    readonly options: {
      config: NeemServerConfig
      applications: Record<string, NeemApplicationConfig>
      worker: NeemServerWorkerConfig
      run?: NeemServerRunOptions
      mode?: 'development' | 'production'
    },
    readonly poolEnvironmentOrchestrator?: NeemPoolEnvironmentOrchestrator,
  ) {
    this.mode = options.mode ?? 'production'
    this.errorPolicy = getErrorPolicy(this.mode)
    this.workerFactory = defaultWorkerFactory
    this.poolFactory = defaultPoolFactory
    this.runApplications =
      options.run?.applications ?? Object.keys(options.config.applications)
    this.logger = createLogger(options.config.logger, 'NeemServer')
    this.logger.trace(options, 'NeemServer initialized')
  }

  async start() {
    const { logger, errorPolicy, workerFactory, poolFactory } = this

    logger.info('Starting neem application server...')
    await this.setupPlugins()

    this.applications = new ApplicationServerApplications({
      logger: this.logger,
      mode: this.mode,
      workerConfig: this.options.worker,
      serverConfig: this.options.config,
      applicationsConfig: this.options.applications,
      applications: this.runApplications,
      errorPolicy,
      workerFactory,
      poolFactory,
      poolEnvironmentOrchestrator: this.poolEnvironmentOrchestrator,
    })

    if (this.options.config.proxy) {
      this.logger.debug('Proxy configuration detected, creating proxy...')
      this.proxy = new ApplicationServerProxy({
        logger: this.logger,
        config: this.options.config.proxy,
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
    await this.poolEnvironmentOrchestrator?.stopAll()
    this.logger.info('Neem application server stopped')
  }

  async restartFailedWorkers(): Promise<number> {
    return (await this.applications?.restartFailedWorkers()) ?? 0
  }

  protected async setupPlugins() {
    const plugins = this.options.config.plugins ?? []

    for (const [instanceId, plugin] of plugins.entries()) {
      const poolName = this.getPluginPoolName(plugin, instanceId)
      this.logger.debug(
        { plugin: plugin.name, instanceId, pool: poolName },
        'Initializing plugin',
      )

      const poolEnvironment = this.poolEnvironmentOrchestrator
        ? await this.poolEnvironmentOrchestrator.ensurePoolEnvironment({
            id: poolName,
            kind: 'plugin',
            owner: plugin.name,
            vite: {},
          })
        : undefined

      const poolConfig: WorkerPoolConfig = {
        name: poolName,
        workerType: WorkerType.Plugin,
        path: this.options.worker.path,
        workerData: {
          ...this.options.worker.workerData,
          mode: this.mode,
          pool: {
            id: poolName,
            kind: 'plugin',
            owner: plugin.name,
            environmentName: poolEnvironment?.environmentName,
          },
        },
        onWorker: this.createPoolWorkerCallback(poolName),
      }

      const pool = this.poolFactory(
        poolConfig,
        this.errorPolicy,
        this.workerFactory,
        this.logger,
      )

      const hooks = new NeemServerPluginHooks()
      if (plugin.hooks) {
        hooks.addHooks(plugin.hooks)
      }

      this.pluginRuntimes.push({
        plugin,
        instanceId,
        poolName,
        pool,
        hooks,
        workers: new Map(),
      })
    }

    for (const runtime of this.pluginRuntimes) {
      const ctx = this.createPluginContext(runtime)
      await runtime.hooks.callHook('server:setup', ctx)
    }

    for (const runtime of this.pluginRuntimes) {
      const ctx = this.createPluginContext(runtime)
      await runtime.hooks.callHook('server:start', ctx)
    }
  }

  protected async disposePlugins() {
    const runtimes = [...this.pluginRuntimes].reverse()

    for (const runtime of runtimes) {
      const ctx = this.createPluginContext(runtime)
      await runtime.hooks.callHook('server:stop', ctx)
      await this.stopAllPluginWorkers(runtime)
      await this.poolEnvironmentOrchestrator?.stopPoolEnvironment(
        runtime.poolName,
      )
      await runtime.hooks.callHook('server:dispose', ctx)
      this.logger.debug(
        { plugin: runtime.plugin.name, instanceId: runtime.instanceId },
        'Plugin disposed',
      )
    }

    this.pluginRuntimes.length = 0
  }

  protected createPluginContext(runtime: {
    instanceId: number
    poolName: string
    pool: WorkerPool
    workers: Map<
      string,
      { worker: ManagedWorker; handle: NeemServerPluginWorkerHandle }
    >
  }): NeemServerPluginContext {
    return {
      mode: this.mode,
      instanceId: runtime.instanceId,
      poolName: runtime.poolName,
      workers: {
        spawn: (options) => this.spawnPluginWorker(runtime, options),
        stop: (workerId) => this.stopPluginWorker(runtime, workerId),
        get: (workerId) => runtime.workers.get(workerId)?.handle,
        list: () => this.listPluginWorkers(runtime),
        stopAll: () => this.stopAllPluginWorkers(runtime),
      },
    }
  }

  protected getPluginPoolName(
    plugin: NeemServerPlugin,
    instanceId: number,
  ): string {
    const normalizedName = plugin.name.replace(/[^a-zA-Z0-9-_]/g, '-')
    return `plugin-${instanceId}-${normalizedName}`
  }

  protected async spawnPluginWorker(
    runtime: {
      instanceId: number
      poolName: string
      pool: WorkerPool
      workers: Map<
        string,
        { worker: ManagedWorker; handle: NeemServerPluginWorkerHandle }
      >
    },
    options: NeemPluginWorkerSpawnOptions,
  ): Promise<NeemServerPluginWorkerHandle> {
    const index = runtime.workers.size
    let sequence = index + 1
    while (runtime.workers.has(`${runtime.poolName}-worker-${sequence}`)) {
      sequence += 1
    }
    const id = options.id ?? `${runtime.poolName}-worker-${sequence}`
    if (runtime.workers.has(id)) {
      throw new Error(`Plugin worker with id [${id}] already exists`)
    }

    const worker = runtime.pool.add(
      {
        ...options.workerData,
        ...(options.ports ? { ports: options.ports } : {}),
      },
      index,
      {
        id,
        name: options.name,
        path: options.path,
        workerType: options.type ?? WorkerType.Plugin,
        workerOptions: {
          ...options.workerOptions,
          transferList: [
            ...(options.workerOptions?.transferList ?? []),
            ...Object.values(options.ports ?? {}),
          ],
        },
        onWorker: this.createPoolWorkerCallback(runtime.poolName),
      },
    )

    const handle: NeemServerPluginWorkerHandle = {
      id,
      name: options.name,
      type: worker.config.workerType,
      path: worker.config.path,
      getState: () => worker.currentState,
      isHealthy: () => worker.isHealthy,
      stop: async () => {
        await this.stopPluginWorker(runtime, id)
      },
    }

    runtime.workers.set(id, { worker, handle })

    try {
      await worker.start()
    } catch (error) {
      runtime.workers.delete(id)
      await runtime.pool.remove(id)
      throw error
    }

    return handle
  }

  protected async stopPluginWorker(
    runtime: {
      pool: WorkerPool
      workers: Map<
        string,
        { worker: ManagedWorker; handle: NeemServerPluginWorkerHandle }
      >
    },
    workerId: string,
  ): Promise<boolean> {
    const entry = runtime.workers.get(workerId)
    if (!entry) return false

    runtime.workers.delete(workerId)
    return await runtime.pool.remove(workerId)
  }

  protected listPluginWorkers(runtime: {
    workers: Map<
      string,
      { worker: ManagedWorker; handle: NeemServerPluginWorkerHandle }
    >
  }): NeemServerPluginWorkerSnapshot[] {
    return Array.from(runtime.workers.values()).map(({ worker, handle }) => ({
      id: handle.id,
      name: handle.name,
      type: handle.type,
      path: handle.path,
      state: worker.currentState,
      healthy: worker.isHealthy,
    }))
  }

  protected async stopAllPluginWorkers(runtime: {
    pool: WorkerPool
    workers: Map<
      string,
      { worker: ManagedWorker; handle: NeemServerPluginWorkerHandle }
    >
  }): Promise<void> {
    const workerIds = Array.from(runtime.workers.keys()).reverse()
    for (const workerId of workerIds) {
      await this.stopPluginWorker(runtime, workerId)
    }

    await runtime.pool.stopAll()
  }

  protected createPoolWorkerCallback(
    poolId: string,
  ): NonNullable<ManagedWorkerConfig['onWorker']> {
    return (worker) => {
      this.options.worker.onWorker?.(worker)
      this.poolEnvironmentOrchestrator?.attachWorker(poolId, worker)
    }
  }
}
