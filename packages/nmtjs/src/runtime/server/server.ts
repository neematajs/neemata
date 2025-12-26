import type EventEmitter from 'node:events'
import type { Worker } from 'node:worker_threads'

import type { Logger } from '@nmtjs/core'
import { createLogger } from '@nmtjs/core'

import type {
  Store,
  ThreadPortMessageTypes,
  WorkerThreadError,
} from '../types.ts'
import type { ServerConfig } from './config.ts'
import { createStoreClient } from '../store/index.ts'
import { ApplicationServerApplications } from './applications.ts'
import { ApplicationServerJobs } from './jobs.ts'
import { ApplicationServerProxy } from './proxy.ts'

export type ApplicationServerRunOptions = {
  applications: string[]
  scheduler: boolean
  jobs: boolean
}

export type ApplicationWorkerReadyEvent = {
  application: string
  threadId: number
  hosts?: ThreadPortMessageTypes['ready']['hosts']
}

export type ApplicationWorkerErrorEvent = {
  application: string
  threadId: number
  error: WorkerThreadError
}

export type ApplicationServerWorkerConfig = {
  path: string
  workerData?: any
  worker?: (worker: Worker) => any
  events?: EventEmitter<{
    worker: [Worker]
    'worker-ready': [ApplicationWorkerReadyEvent]
    'worker-error': [ApplicationWorkerErrorEvent]
  }>
}

export class ApplicationServer {
  logger: Logger

  applications?: ApplicationServerApplications
  jobRunners?: ApplicationServerJobs

  proxy?: ApplicationServerProxy
  store?: Store

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
  ) {
    this.logger = createLogger(config.logger, 'Server')
    this.logger.trace(
      { applications: applicationsConfig, workerConfig, runOptions },
      'ApplicationServer initialized',
    )
  }

  async start() {
    const { config, logger } = this
    logger.info('Starting application server...')

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

    this.logger.info('Application server stopped')
  }
}
