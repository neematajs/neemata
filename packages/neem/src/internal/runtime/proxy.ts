import type { NeemProxyConfig } from '#public/config.ts'
import type { NeemApplicationUpstream } from '#public/runtime.ts'
import { createNeemChildLogger } from '#runtime/logger.ts'
import type { NeemRuntimeSnapshot } from '#runtime/snapshot.ts'

export type NeemProxyUpstream = {
  type: 'port'
  transport: string
  secure: boolean
  hostname: string
  port: number
}

export type NeemProxyUpstreamSnapshot = {
  appName: string
  upstream: NeemApplicationUpstream
  proxyUpstream: NeemProxyUpstream
  count: number
}

export type NeemProxyUpstreamRegistryEvent = NeemProxyUpstreamSnapshot

type Listener = (event: NeemProxyUpstreamRegistryEvent) => void

type RegistryEntry = {
  upstream: NeemApplicationUpstream
  proxyUpstream: NeemProxyUpstream
  count: number
}

export class NeemProxyUpstreamRegistry {
  private readonly upstreams = new Map<string, Map<string, RegistryEntry>>()
  private readonly upstreamsByOwner = new WeakMap<
    object,
    Array<{ appName: string; key: string }>
  >()
  private readonly listeners = {
    add: new Set<Listener>(),
    remove: new Set<Listener>(),
  }

  addOwnerUpstreams(
    owner: object,
    appName: string,
    upstreams: readonly NeemApplicationUpstream[],
  ): void {
    this.removeOwnerUpstreams(owner)

    const keys: Array<{ appName: string; key: string }> = []
    for (const upstream of upstreams) {
      const normalized = normalizeProxyApplicationUpstream(upstream)
      const proxyUpstream = toProxyUpstream(normalized)
      const key = getUpstreamKey(normalized)
      keys.push({ appName, key })
      this.addUpstream(appName, key, normalized, proxyUpstream)
    }

    if (keys.length > 0) {
      this.upstreamsByOwner.set(owner, keys)
    }
  }

  removeOwnerUpstreams(owner: object): void {
    const keys = this.upstreamsByOwner.get(owner)
    if (!keys) return
    this.upstreamsByOwner.delete(owner)

    for (const { appName, key } of keys) {
      const appUpstreams = this.upstreams.get(appName)
      const current = appUpstreams?.get(key)
      if (!current) continue

      current.count--
      if (current.count > 0) continue

      appUpstreams?.delete(key)
      this.emit('remove', {
        appName,
        upstream: current.upstream,
        proxyUpstream: current.proxyUpstream,
        count: 0,
      })
      if (appUpstreams && appUpstreams.size === 0) {
        this.upstreams.delete(appName)
      }
    }
  }

  list(appName?: string): readonly NeemProxyUpstreamSnapshot[] {
    const entries =
      appName === undefined
        ? [...this.upstreams.entries()]
        : [[appName, this.upstreams.get(appName)] as const]
    return entries.flatMap(([name, upstreams]) =>
      [...(upstreams?.values() ?? [])].map((entry) => ({
        appName: name,
        upstream: entry.upstream,
        proxyUpstream: entry.proxyUpstream,
        count: entry.count,
      })),
    )
  }

  on(event: 'add' | 'remove', listener: Listener): () => void {
    this.listeners[event].add(listener)
    return () => {
      this.listeners[event].delete(listener)
    }
  }

  private addUpstream(
    appName: string,
    key: string,
    upstream: NeemApplicationUpstream,
    proxyUpstream: NeemProxyUpstream,
  ): void {
    let appUpstreams = this.upstreams.get(appName)
    if (!appUpstreams) {
      appUpstreams = new Map()
      this.upstreams.set(appName, appUpstreams)
    }

    const current = appUpstreams.get(key)
    if (current) {
      current.count++
      return
    }

    appUpstreams.set(key, { upstream, proxyUpstream, count: 1 })
    this.emit('add', { appName, upstream, proxyUpstream, count: 1 })
  }

  private emit(event: 'add' | 'remove', data: NeemProxyUpstreamRegistryEvent) {
    for (const listener of this.listeners[event]) {
      listener(data)
    }
  }
}

export type NeemProxyManagerOptions = {
  snapshot: NeemRuntimeSnapshot
  upstreams: NeemProxyUpstreamRegistry
  loadProxyPackage?: NeemProxyPackageLoader
}

export type NeemNativeProxy = {
  start: () => Promise<undefined>
  stop: () => Promise<undefined>
  addUpstream: (
    appName: string,
    upstream: NeemProxyUpstream,
  ) => Promise<undefined>
  removeUpstream: (
    appName: string,
    upstream: NeemProxyUpstream,
  ) => Promise<undefined>
}

export type NeemProxyPackageLoader = () => Promise<{
  Proxy: new (options: NeemNativeProxyOptions) => NeemNativeProxy
}>

export type NeemNativeProxyOptions = {
  listen: string
  tls?: { keyPath: string; certPath: string }
  applications: Array<{
    name: string
    routing: { type?: 'subdomain' | 'path'; name?: string; default?: boolean }
    sni?: string
  }>
  healthCheckIntervalMs?: number
  stickySessions?: NeemProxyConfig['stickySessions']
}

export class NeemProxyManager {
  private readonly logger: NeemRuntimeSnapshot['logger']
  private readonly config: NeemProxyConfig
  private readonly loadProxyPackage: NeemProxyPackageLoader
  private proxy: NeemNativeProxy | undefined
  private offAdd: (() => void) | undefined
  private offRemove: (() => void) | undefined

  constructor(private readonly options: NeemProxyManagerOptions) {
    const config = options.snapshot.config.proxy
    if (!config) throw new Error('Cannot create Neem proxy without config')

    this.config = config
    this.logger = createNeemChildLogger(options.snapshot.logger, 'Neem proxy')
    this.loadProxyPackage = options.loadProxyPackage ?? loadProxyPackage
  }

  async start(): Promise<void> {
    if (this.proxy) return

    const proxyPackage = await this.loadProxyPackage()
    this.proxy = new proxyPackage.Proxy(
      createNativeProxyOptions(
        this.config,
        Object.keys(this.options.snapshot.manifest.apps),
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
        applications: Object.keys(this.options.snapshot.manifest.apps),
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

  private async addUpstream(
    event: NeemProxyUpstreamRegistryEvent,
  ): Promise<void> {
    if (!this.proxy) return

    try {
      await this.proxy.addUpstream(event.appName, event.proxyUpstream)
    } catch (error) {
      this.logger.warn(
        new Error(`Failed to add proxy upstream for app [${event.appName}]`, {
          cause: error,
        }),
      )
    }
  }

  private async removeUpstream(
    event: NeemProxyUpstreamRegistryEvent,
  ): Promise<void> {
    if (!this.proxy) return

    try {
      await this.proxy.removeUpstream(event.appName, event.proxyUpstream)
    } catch (error) {
      this.logger.warn(
        new Error(
          `Failed to remove proxy upstream for app [${event.appName}]`,
          { cause: error },
        ),
      )
    }
  }
}

export function normalizeProxyApplicationUpstream(
  upstream: NeemApplicationUpstream,
): NeemApplicationUpstream {
  const url = new URL(upstream.url)
  if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1'
  return { type: upstream.type, url: url.toString() }
}

export function toProxyUpstream(
  upstream: NeemApplicationUpstream,
): NeemProxyUpstream {
  const url = new URL(upstream.url)
  const secure = url.protocol === 'https:' || url.protocol === 'wss:'
  const port = url.port ? Number.parseInt(url.port, 10) : secure ? 443 : 80
  return {
    type: 'port',
    transport: upstream.type,
    secure,
    hostname: url.hostname,
    port,
  }
}

function getUpstreamKey(upstream: NeemApplicationUpstream): string {
  return `${upstream.type}:${upstream.url}`
}

function createNativeProxyOptions(
  config: NeemProxyConfig,
  appNames: readonly string[],
): NeemNativeProxyOptions {
  const configured = config.applications ?? {}
  const names =
    Object.keys(configured).length > 0 ? Object.keys(configured) : appNames

  return {
    listen: `${config.hostname}:${config.port}`,
    tls: config.tls
      ? { keyPath: config.tls.key, certPath: config.tls.cert }
      : undefined,
    applications: names.flatMap((name) => {
      const app = configured[name]
      if (app === undefined && Object.keys(configured).length > 0) return []
      return [
        {
          name,
          routing: app?.routing ?? { type: 'path', name },
          sni: app?.sni,
        },
      ]
    }),
    healthCheckIntervalMs: config.healthChecks?.interval,
    stickySessions: config.stickySessions,
  }
}

async function loadProxyPackage() {
  return await dynamicImport('@nmtjs/proxy')
}

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<{
  Proxy: new (options: NeemNativeProxyOptions) => NeemNativeProxy
}>
