import EventEmitter from 'node:events'

import type { Logger } from '@nmtjs/core'
import type { ProxyableTransportType } from '@nmtjs/gateway'

import type { ThreadPortMessageTypes, WorkerThreadError } from '../types.ts'
import type { ServerApplicationConfig, ServerConfig } from './config.ts'
import type { ErrorPolicy } from './error-policy.ts'
import type { ManagedWorker } from './managed-worker.ts'
import type { ApplicationServerWorkerConfig } from './types.ts'
import type {
  ManagedWorkerFactory,
  WorkerPool,
  WorkerPoolConfig,
  WorkerPoolFactory,
} from './worker-pool.ts'
import { WorkerType } from '../enums.ts'

export type ApplicationProxyUpstream = {
  type: ProxyableTransportType
  url: string
}

/**
 * ApplicationServerApplications manages all application worker pools.
 *
 * Changes from the old Pool-based implementation:
 * - Uses WorkerPool for each application (isolated failure domains)
 * - Uses ManagedWorker for restart logic and state tracking
 * - Integrates with ErrorPolicy for restart decisions
 * - Proper health tracking per application
 */
export class ApplicationServerApplications extends EventEmitter<{
  add: [application: string, upstream: ApplicationProxyUpstream]
  remove: [application: string, upstream: ApplicationProxyUpstream]
}> {
  /** Worker pools per application */
  private pools = new Map<string, WorkerPool>()

  /** Upstreams for proxy routing */
  protected readonly upstreams = new Map<
    string,
    Map<string, { upstream: ApplicationProxyUpstream; count: number }>
  >()

  /** Track upstreams by worker for cleanup */
  protected readonly upstreamsByWorker = new WeakMap<
    ManagedWorker,
    Array<{ application: string; key: string }>
  >()

  constructor(
    readonly params: {
      logger: Logger
      applications: string[]
      workerConfig: ApplicationServerWorkerConfig
      applicationsConfig: Record<
        string,
        { type: 'neemata' | 'custom'; specifier: string }
      >
      serverConfig: ServerConfig
      errorPolicy: ErrorPolicy
      workerFactory: ManagedWorkerFactory
      poolFactory: WorkerPoolFactory
    },
  ) {
    super()
  }

  get appsNames() {
    return this.params.applications
  }

  /**
   * Start all application workers.
   */
  async start() {
    const {
      logger,
      applications,
      applicationsConfig,
      serverConfig,
      workerConfig,
      errorPolicy,
      workerFactory,
      poolFactory,
    } = this.params

    for (const applicationName of applications) {
      const applicationPath = applicationsConfig[applicationName]
      if (!applicationPath) {
        logger.warn(
          `Application [${applicationName}] not found in applicationsConfig, skipping...`,
        )
        continue
      }

      const applicationConfig = serverConfig.applications[
        applicationName
      ] as ServerApplicationConfig

      const threadsConfig = Array.isArray(applicationConfig.threads)
        ? applicationConfig.threads
        : new Array(applicationConfig.threads).fill(undefined)

      logger.debug(
        `Spinning [${threadsConfig.length}] workers for [${applicationName}] application...`,
      )

      // Create a WorkerPool for this application
      const poolConfig: WorkerPoolConfig = {
        name: `application-${applicationName}`,
        workerType: WorkerType.Application,
        path: workerConfig.path,
        workerData: { ...workerConfig.workerData },
        onWorker: workerConfig.worker,
      }

      const pool = poolFactory(poolConfig, errorPolicy, workerFactory, logger)

      // Add workers to the pool
      for (let i = 0; i < threadsConfig.length; i++) {
        const workerData = {
          runtime: {
            type: 'application',
            name: applicationName,
            path: applicationPath.specifier,
            transportsData: threadsConfig[i],
          },
        }

        const worker = pool.add(workerData, i)

        // Handle worker ready - update upstreams
        worker.on('ready', (hosts) => {
          this.removeWorkerUpstreams(worker)

          const keys: Array<{ application: string; key: string }> = []
          const sanitizedHosts: ThreadPortMessageTypes['ready']['hosts'] = []

          if (hosts?.length) {
            for (const host of hosts) {
              const url = new URL(host.url)
              if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1'

              const normalizedUrl = url.toString()
              sanitizedHosts.push({ type: host.type, url: normalizedUrl })

              const upstream: ApplicationProxyUpstream = {
                type: host.type,
                url: normalizedUrl,
              }

              const key = `${upstream.type}:${upstream.url}`
              keys.push({ application: applicationName, key })
              this.addUpstream(applicationName, key, upstream)
            }
          }

          this.upstreamsByWorker.set(worker, keys)
        })

        // Handle worker error - clean up upstreams
        worker.on('error', (_error: WorkerThreadError) => {
          this.removeWorkerUpstreams(worker)
        })

        // Handle worker state changes for upstream cleanup
        worker.on('state-change', (from, to) => {
          if (to === 'stopping' || to === 'stopped' || to === 'error') {
            this.removeWorkerUpstreams(worker)
          }
        })
      }

      this.pools.set(applicationName, pool)
    }

    // Start all pools
    await Promise.all([...this.pools.values()].map((p) => p.startAll()))
  }

  /**
   * Stop all application workers.
   */
  async stop() {
    await Promise.all([...this.pools.values()].map((p) => p.stopAll()))
    this.pools.clear()
  }

  /**
   * Restart failed workers across all pools.
   * Called when HMR update comes in and workers may have failed.
   * @returns Number of workers that were restarted
   */
  async restartFailedWorkers(): Promise<number> {
    let total = 0
    for (const pool of this.pools.values()) {
      total += await pool.restartFailedWorkers()
    }
    return total
  }

  /**
   * Get pool for an application.
   */
  getPool(applicationName: string): WorkerPool | undefined {
    return this.pools.get(applicationName)
  }

  /**
   * Add an upstream for proxy routing.
   */
  protected addUpstream(
    application: string,
    key: string,
    upstream: ApplicationProxyUpstream,
  ) {
    let appUpstreams = this.upstreams.get(application)
    if (!appUpstreams) {
      appUpstreams = new Map()
      this.upstreams.set(application, appUpstreams)
    }

    const current = appUpstreams.get(key)
    if (!current) {
      appUpstreams.set(key, { upstream, count: 1 })
      this.emit('add', application, upstream)
      return
    }

    current.count++
  }

  /**
   * Remove upstreams associated with a worker.
   */
  protected removeWorkerUpstreams(worker: ManagedWorker) {
    const keys = this.upstreamsByWorker.get(worker)
    if (!keys) return
    this.upstreamsByWorker.delete(worker)

    for (const { application, key } of keys) {
      const appUpstreams = this.upstreams.get(application)
      const current = appUpstreams?.get(key)
      if (!current) continue

      current.count--
      if (current.count <= 0) {
        appUpstreams?.delete(key)
        this.emit('remove', application, current.upstream)
      }
      if (appUpstreams && appUpstreams.size === 0) {
        this.upstreams.delete(application)
      }
    }
  }
}
