import type { Logger } from '@nmtjs/core'
import { Proxy as NeemataProxy } from '@nmtjs/proxy'

import type { ApplicationServerApplications } from './applications.ts'
import type { ServerConfig } from './config.ts'

export class ApplicationServerProxy {
  proxyServer: NeemataProxy

  protected readonly onAdd: (application: string, upstream: any) => void
  protected readonly onRemove: (application: string, upstream: any) => void

  constructor(
    readonly params: {
      logger: Logger
      config: ServerConfig['proxy']
      applications: ApplicationServerApplications
    },
  ) {
    const { config } = params
    if (!config) {
      throw new Error('Proxy config is required')
    }

    this.proxyServer = new NeemataProxy({
      listen: `${config.hostname}:${config.port}`,
      tls: config.tls
        ? { keyPath: config.tls.key, certPath: config.tls.cert }
        : undefined,
      applications: [],
    })

    this.onAdd = (application, upstream) => {
      this.params.logger.debug(
        { application, upstream },
        'Adding upstream to proxy',
      )
      void this.proxyServer
        .addUpstream(application, upstream)
        .catch((error) => {
          this.params.logger.warn(
            { error, application, upstream },
            'Failed to add upstream to proxy',
          )
        })
    }

    this.onRemove = (application, upstream) => {
      this.params.logger.debug(
        { application, upstream },
        'Removing upstream from proxy',
      )

      void this.proxyServer
        .removeUpstream(application, upstream)
        .catch((error) => {
          this.params.logger.warn(
            { error, application, upstream },
            'Failed to remove upstream from proxy',
          )
        })
    }

    params.applications.on('add', this.onAdd)
    params.applications.on('remove', this.onRemove)
  }

  async start() {
    const { config } = this.params
    if (!config) {
      throw new Error('Proxy config is required')
    }
    this.params.logger.info(
      { hostname: config.hostname, port: config.port, threads: config.threads },
      'Starting proxy server...',
    )
    await this.proxyServer.start()
  }

  async stop() {
    this.params.logger.info('Stopping proxy server...')

    this.params.applications.off('add', this.onAdd)
    this.params.applications.off('remove', this.onRemove)

    await this.proxyServer.stop()
  }
}
