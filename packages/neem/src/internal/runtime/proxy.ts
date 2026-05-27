import type { NeemProxyConfig } from '../../public/config.ts'
import type {
  NeemProxyUpstream,
  NeemProxyUpstreamRegistry,
  NeemProxyUpstreamRegistryEvent,
  NeemProxyUpstreamSnapshot,
} from './proxy-upstreams.ts'
import type { NeemRuntimeSnapshot } from './snapshot.ts'
import { createNeemChildLogger } from './logger.ts'

export * from './proxy-upstreams.ts'

export type NeemProxyManagerOptions = {
  snapshot: NeemRuntimeSnapshot
  upstreams: NeemProxyUpstreamRegistry
}

export type NeemProxyHealth = {
  enabled: boolean
  running: boolean
  upstreams: readonly NeemProxyUpstreamSnapshot[]
}

export type NeemNativeProxy = {
  start: () => Promise<undefined>
  stop: () => Promise<undefined>
  addUpstream: (
    runtimeName: string,
    upstream: NeemProxyUpstream,
  ) => Promise<undefined>
  removeUpstream: (
    runtimeName: string,
    upstream: NeemProxyUpstream,
  ) => Promise<undefined>
}

export type NeemNativeProxyOptions = {
  listen: string
  tls?: { keyPath: string; certPath: string }
  // @nmtjs/proxy still names route groups "applications"; Neem maps runtimes into that native shape.
  applications: Array<{
    name: string
    routing: { type?: 'subdomain' | 'path'; name?: string; default?: boolean }
    sni?: string
  }>
  healthCheckIntervalMs?: number
  stickySessions?: NeemProxyConfig['stickySessions']
}

type NeemNativeProxyConstructor = new (
  options: NeemNativeProxyOptions,
) => NeemNativeProxy

export class NeemProxyManager {
  private readonly logger: NeemRuntimeSnapshot['logger']
  private readonly config: NeemProxyConfig
  private proxy: NeemNativeProxy | undefined
  private offAdd: (() => void) | undefined
  private offRemove: (() => void) | undefined

  constructor(private readonly options: NeemProxyManagerOptions) {
    const config = options.snapshot.config.proxy
    if (!config) throw new Error('Cannot create Neem proxy without config')

    this.config = config
    this.logger = createNeemChildLogger(options.snapshot.logger, 'Neem proxy')
  }

  async start(): Promise<void> {
    if (this.proxy) return

    const proxyPackage = await loadProxyPackage()
    this.proxy = new proxyPackage.Proxy(
      createNativeProxyOptions(
        this.config,
        Object.keys(this.options.snapshot.manifest.runtimes ?? {}),
      ),
    )

    this.offAdd = this.options.upstreams.on('add', (event) => {
      void this.addUpstream(event)
    })
    this.offRemove = this.options.upstreams.on('remove', (event) => {
      void this.removeUpstream(event)
    })

    for (const event of this.options.upstreams.list()) {
      await this.addUpstream(event)
    }

    this.logger.info(
      {
        hostname: this.config.hostname,
        port: this.config.port,
        runtimes: Object.keys(this.options.snapshot.manifest.runtimes ?? {}),
      },
      'Starting Neem proxy',
    )
    await this.proxy.start()
    this.logger.info('Neem proxy started')
  }

  async stop(): Promise<void> {
    const proxy = this.proxy
    this.proxy = undefined
    this.offAdd?.()
    this.offRemove?.()
    this.offAdd = undefined
    this.offRemove = undefined

    if (!proxy) return
    this.logger.info('Stopping Neem proxy')
    await proxy.stop()
    this.logger.info('Neem proxy stopped')
  }

  getHealth(): NeemProxyHealth {
    return {
      enabled: true,
      running: Boolean(this.proxy),
      upstreams: [...this.options.upstreams.list()],
    }
  }

  private async addUpstream(
    event: NeemProxyUpstreamRegistryEvent,
  ): Promise<void> {
    if (!this.proxy) return

    try {
      await this.proxy.addUpstream(event.runtimeName, event.proxyUpstream)
    } catch (error) {
      this.logger.warn(
        new Error(
          `Failed to add proxy upstream for runtime [${event.runtimeName}]`,
          { cause: error },
        ),
      )
    }
  }

  private async removeUpstream(
    event: NeemProxyUpstreamRegistryEvent,
  ): Promise<void> {
    if (!this.proxy) return

    try {
      await this.proxy.removeUpstream(event.runtimeName, event.proxyUpstream)
    } catch (error) {
      this.logger.warn(
        new Error(
          `Failed to remove proxy upstream for runtime [${event.runtimeName}]`,
          { cause: error },
        ),
      )
    }
  }
}

export function createNativeProxyOptions(
  config: NeemProxyConfig,
  runtimeNames: readonly string[],
): NeemNativeProxyOptions {
  const configured = config.runtimes ?? {}
  const active = new Set(runtimeNames)
  const names =
    Object.keys(configured).length > 0
      ? Object.keys(configured).filter((name) => active.has(name))
      : runtimeNames

  return {
    listen: `${config.hostname}:${config.port}`,
    tls: config.tls
      ? { keyPath: config.tls.key, certPath: config.tls.cert }
      : undefined,
    applications: names.flatMap((name) => {
      const runtime = configured[name]
      if (runtime === undefined && Object.keys(configured).length > 0) return []
      return [
        {
          name,
          routing: runtime?.routing ?? { type: 'path', name },
          sni: runtime?.sni,
        },
      ]
    }),
    healthCheckIntervalMs: config.healthChecks?.interval,
    stickySessions: config.stickySessions,
  }
}

async function loadProxyPackage() {
  const module = await import('@nmtjs/proxy')
  return normalizeProxyPackage(module)
}

function normalizeProxyPackage(module: unknown): {
  Proxy: NeemNativeProxyConstructor
} {
  const candidates = [
    module,
    (module as { default?: unknown })?.default,
    (module as { 'module.exports'?: unknown })?.['module.exports'],
    (
      (module as { default?: { default?: unknown } })?.default as {
        default?: unknown
      }
    )?.default,
    (
      (module as { default?: { 'module.exports'?: unknown } })?.default as {
        'module.exports'?: unknown
      }
    )?.['module.exports'],
  ]

  for (const candidate of candidates) {
    const ProxyConstructor = (
      candidate as { Proxy?: NeemNativeProxyConstructor } | undefined
    )?.Proxy
    if (typeof ProxyConstructor === 'function') {
      return { Proxy: ProxyConstructor }
    }
  }

  throw new Error('Invalid @nmtjs/proxy module: missing Proxy export')
}
