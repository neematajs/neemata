import type { Logger } from '@nmtjs/core'
import { Proxy as NeemataProxy } from '@nmtjs/proxy'

import type {
  ApplicationProxyUpstream,
  ApplicationServerApplications,
} from './applications.ts'
import type { ServerConfig } from './config.ts'

/**
 * Transform ApplicationProxyUpstream to the format expected by Rust proxy.
 */
function toProxyUpstream(upstream: ApplicationProxyUpstream) {
  const url = new URL(upstream.url)
  const isWebSocket = url.protocol === 'wss:' || url.protocol === 'ws:'
  const secure = url.protocol === 'https:' || url.protocol === 'wss:'
  const port = url.port ? Number.parseInt(url.port, 10) : secure ? 443 : 80

  return {
    type: 'port',
    // WebSocket requires HTTP/1.1 for upgrade
    transport: isWebSocket ? 'http' : upstream.type,
    secure,
    hostname: url.hostname,
    port,
  }
}

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
      applications: Object.entries(config.applications)
        .filter(([_, options]) => options !== undefined)
        .map(([app, options]) => ({
          name: app,
          routing: options!.routing,
          sni: options!.sni,
        })),
    })

    this.onAdd = (application, upstream) => {
      const proxyUpstream = toProxyUpstream(upstream)
      this.params.logger.debug(
        { application, upstream: proxyUpstream },
        'Adding upstream to proxy',
      )
      void this.proxyServer
        .addUpstream(application, proxyUpstream)
        .catch((error) => {
          this.params.logger.warn(
            { error, application, upstream: proxyUpstream },
            'Failed to add upstream to proxy',
          )
        })
    }

    this.onRemove = (application, upstream) => {
      const proxyUpstream = toProxyUpstream(upstream)
      this.params.logger.debug(
        { application, upstream: proxyUpstream },
        'Removing upstream from proxy',
      )

      void this.proxyServer
        .removeUpstream(application, proxyUpstream)
        .catch((error) => {
          this.params.logger.warn(
            { error, application, upstream: proxyUpstream },
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
      'Proxy configuration',
    )
    await this.proxyServer.start()
  }

  async stop() {
    this.params.applications.off('add', this.onAdd)
    this.params.applications.off('remove', this.onRemove)

    await this.proxyServer.stop()
  }
}
