import type { Logger } from '@nmtjs/core'
import { createLogger } from '@nmtjs/core'

import type { MetricsServer } from '../metrics/server.ts'
import type { Store } from '../types.ts'
import type { ServerConfig } from './config.ts'
import type { ErrorPolicy } from './error-policy.ts'
import type { ManagedWorkerConfig } from './managed-worker.ts'
import type {
  ApplicationServerRunOptions,
  ApplicationServerWorkerConfig,
} from './types.ts'
import type {
  ManagedWorkerFactory,
  WorkerPoolConfig,
  WorkerPoolFactory,
} from './worker-pool.ts'
import { createMetricsServer } from '../metrics/server.ts'
import { createStoreClient } from '../store/index.ts'
import { ApplicationServerApplications } from './applications.ts'
import { DevErrorPolicy } from './error-policy.ts'
import { ApplicationServerJobs } from './jobs.ts'
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
 * ApplicationServer is the main server orchestrator.
 *
 * It manages:
 * - Application worker pools
 * - Job runner pools
 * - Reverse proxy
 * - Store connections
 *
 * The server integrates with ErrorPolicy for proper error handling
 * and uses ManagedWorker for worker lifecycle management.
 */
export class ApplicationServer {
  logger: Logger

  applications?: ApplicationServerApplications
  jobRunners?: ApplicationServerJobs

  proxy?: ApplicationServerProxy
  store?: Store
  metrics?: MetricsServer

  constructor(
    readonly config: ServerConfig,
    readonly applicationsConfig: Record<
      string,
      { type: 'neemata' | 'custom'; specifier: string }
    >,
    readonly workerConfig: ApplicationServerWorkerConfig,
    readonly runOptions: ApplicationServerRunOptions = {
      applications: Object.keys(config.applications),
      scheduler: false,
      jobs: Boolean(config.jobs?.jobs.size),
    },
    readonly errorPolicy: ErrorPolicy = DevErrorPolicy,
    readonly workerFactory: ManagedWorkerFactory = defaultWorkerFactory,
    readonly poolFactory: WorkerPoolFactory = defaultPoolFactory,
  ) {
    this.logger = createLogger(config.logger, 'Server')
    this.logger.trace(
      { applications: applicationsConfig, workerConfig, runOptions },
      'ApplicationServer initialized',
    )
  }

  async start() {
    const { config, logger, errorPolicy, workerFactory, poolFactory } = this
    logger.info('Starting application server...')

    if (config.metrics) {
      this.metrics = await createMetricsServer(this.logger, config.metrics)
      await this.metrics.start()
      logger.info('Metrics server started')
    }

    if (config.store) {
      this.store = await createStoreClient(config.store)
      await this.store.connect()
      logger.debug('Store connected')
    }

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

    if (this.runOptions.jobs) {
      if (!this.store) {
        throw new Error(
          'Jobs feature requires a store configuration. ' +
            'Please configure `store` in your server config or disable jobs.',
        )
      }
      this.jobRunners = new ApplicationServerJobs({
        logger: this.logger,
        workerConfig: this.workerConfig,
        serverConfig: this.config,
        store: this.store,
        errorPolicy,
        workerFactory,
        poolFactory,
      })
    }

    if (this.config.proxy) {
      this.proxy = new ApplicationServerProxy({
        logger: this.logger,
        config: this.config.proxy,
        applications: this.applications,
      })
    }

    await this.applications.start()

    if (this.runOptions.jobs) {
      await this.jobRunners?.start()
    }

    if (this.runOptions.scheduler && config.jobs?.scheduler) {
      throw new Error(
        'JobsScheduler is currently a work in progress and not available. ' +
          'Scheduled jobs will be supported in a future release.',
      )
    }

    if (this.proxy) {
      await this.proxy.start()
    }

    logger.info('Application server started')
  }

  async stop() {
    this.logger.info('Stopping application server...')

    // Stop proxy + stop accepting new jobs first
    await this.proxy?.stop()
    await this.jobRunners?.stop()

    // Stop applications
    await this.applications?.stop()

    // Close store connection
    if (this.store) {
      this.logger.debug('Closing store...')
      this.store.disconnect(false)
    }

    if (this.metrics) {
      this.logger.info('Stopping metrics server...')
      await this.metrics.stop()
    }

    this.logger.info('Application server stopped')
  }

  /**
   * Restart failed workers across all pools.
   * Called when HMR update comes in and workers may have failed.
   * @returns Number of workers that were restarted
   */
  async restartFailedWorkers(): Promise<number> {
    return (await this.applications?.restartFailedWorkers()) ?? 0
  }
}
