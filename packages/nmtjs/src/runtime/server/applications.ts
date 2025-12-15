import { EventEmitter } from 'node:events'

import type { Logger } from '@nmtjs/core'
import type { ProxyableTransportType } from '@nmtjs/gateway'

import type { ThreadPortMessageTypes, WorkerThreadError } from '../types.ts'
import type { ServerApplicationConfig, ServerConfig } from './config.ts'
import type { Thread } from './pool.ts'
import type {
  ApplicationServerWorkerConfig,
  ApplicationWorkerErrorEvent,
  ApplicationWorkerReadyEvent,
} from './server.ts'
import { Pool } from './pool.ts'

export type ApplicationProxyUpstream = {
  type: ProxyableTransportType
  url: string
}

export class ApplicationServerApplications extends EventEmitter<{
  add: [application: string, upstream: ApplicationProxyUpstream]
  remove: [application: string, upstream: ApplicationProxyUpstream]
}> {
  pool: Pool

  protected readonly upstreams = new Map<
    string,
    Map<string, { upstream: ApplicationProxyUpstream; count: number }>
  >()
  protected readonly upstreamsByThread = new WeakMap<
    Thread,
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
    },
  ) {
    super()
    this.pool = new Pool({
      path: this.params.workerConfig.path,
      worker: this.params.workerConfig.worker,
      workerData: { ...this.params.workerConfig.workerData },
    })
  }

  get appsNames() {
    return this.params.applications
  }

  async start() {
    const { logger, applications, applicationsConfig, serverConfig } =
      this.params

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

      logger.info(
        `Spinning [${threadsConfig.length}] workers for [${applicationName}] application...`,
      )

      for (let i = 0; i < threadsConfig.length; i++) {
        const thread = this.pool.add({
          index: i,
          name: `application-${applicationName}`,
          workerData: {
            runtime: {
              type: 'application',
              name: applicationName,
              path: applicationPath.specifier,
              transportsData: threadsConfig[i],
            },
          },
        })

        thread.on('ready', ({ hosts }) => {
          this.removeThreadUpstreams(thread)

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

          this.upstreamsByThread.set(thread, keys)

          this.emitWorkerReady({
            application: applicationName,
            threadId: thread.worker.threadId,
            hosts: sanitizedHosts.length ? sanitizedHosts : undefined,
          })
        })

        thread.on('error', (error: WorkerThreadError) => {
          this.emitWorkerError({
            application: applicationName,
            threadId: thread.worker.threadId,
            error,
          })
          this.removeThreadUpstreams(thread)
        })

        thread.worker.once('exit', () => {
          this.removeThreadUpstreams(thread)
        })
      }
    }

    await this.pool.start()
  }

  async stop() {
    await this.pool.stop()
  }

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

  protected removeThreadUpstreams(thread: Thread) {
    const keys = this.upstreamsByThread.get(thread)
    if (!keys) return
    this.upstreamsByThread.delete(thread)

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

  protected emitWorkerReady(event: ApplicationWorkerReadyEvent) {
    this.params.workerConfig.events?.emit('worker-ready', event)
  }

  protected emitWorkerError(event: ApplicationWorkerErrorEvent) {
    this.params.logger.error(
      new Error(
        `Worker [${event.application}] thread ${event.threadId} error`,
        { cause: event.error },
      ),
    )
    this.params.workerConfig.events?.emit('worker-error', event)
  }
}
