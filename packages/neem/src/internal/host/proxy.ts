import { OperationQueue } from '@nmtjs/common'

import type {
  NeemProxyConfig,
  NeemProxyHealth,
  NeemProxyUpstream,
  NeemProxyUpstreamFailure,
  NeemProxyUpstreamSnapshot,
  NeemRuntimeProxyConfig,
  NeemRuntimeUpstream,
} from '../../shared/types.ts'
import type { RuntimeSnapshot } from '../manifest/snapshot.ts'
import { childLogger } from '../logger.ts'
import { normalizeError } from '../utils.ts'

export type NativeProxy = {
  start: () => Promise<void>
  stop: () => Promise<void>
  address: () => { hostname: string; port: number } | null
  addUpstream: (
    runtimeName: string,
    upstream: NeemProxyUpstream,
  ) => Promise<void>
  removeUpstream: (
    runtimeName: string,
    upstream: NeemProxyUpstream,
  ) => Promise<void>
}

export type NativeProxyOptions = {
  listen: string
  tls?: { keyPath: string; certPath: string }
  applications: Array<{
    name: string
    routing: NativeProxyRouting
    sni?: string
  }>
  healthCheckIntervalMs?: number
  stickySessions?: NeemProxyConfig['stickySessions']
}

type NativeProxyRouting =
  | { type: 'path'; name?: string }
  | { type: 'subdomain'; name?: string }
  | { type: 'default' }

type NativeProxyConstructor = new (options: NativeProxyOptions) => NativeProxy
type RuntimeProxyConfigs = Record<
  string,
  { proxy?: NeemRuntimeProxyConfig } | undefined
>

export class ProxyController {
  private readonly config: NeemProxyConfig
  private readonly logger: RuntimeSnapshot['logger']
  private readonly mutations = new OperationQueue()
  private proxy: NativeProxy | undefined
  private running = false
  private desired = new Map<string, NeemProxyUpstreamSnapshot>()
  private applied = new Map<string, NeemProxyUpstreamSnapshot>()
  private failures = new Map<string, NeemProxyUpstreamFailure>()
  private mutationError: Error | undefined

  constructor(private readonly snapshot: RuntimeSnapshot) {
    const config = snapshot.config.proxy
    if (!config) throw new Error('Cannot create Neem proxy without config')
    this.config = config
    this.logger = childLogger(snapshot.logger, 'neem:proxy')
  }

  async start(upstreams: readonly RuntimeUpstreams[]): Promise<void> {
    if (this.proxy) return

    const ProxyConstructor = (await loadProxyPackage()).Proxy
    this.proxy = new ProxyConstructor(
      createNativeProxyOptions(this.config, this.snapshot.config.runtimes),
    )
    this.desired = createDesiredUpstreams(
      filterRuntimeUpstreams(upstreams, this.snapshot.config.runtimes),
    )

    try {
      for (const upstream of this.desired.values()) {
        await this.addUpstream(upstream)
      }
      await this.proxy.start()
      this.running = true
      this.logger.info('Neem proxy started')
      this.logger.trace(
        {
          listen: `${this.config.hostname}:${this.config.port}`,
          upstreams: this.desired.size,
        },
        'Neem proxy upstreams',
      )
    } catch (error) {
      const proxy = this.proxy
      this.proxy = undefined
      this.running = false
      this.applied.clear()
      this.failures.clear()
      await proxy?.stop().catch(() => undefined)
      throw error
    }
  }

  async stop(): Promise<void> {
    const proxy = this.proxy
    this.proxy = undefined
    this.running = false
    if (!proxy) return

    this.logger.info('Neem proxy stopping')
    await this.waitForIdle().catch((error) => {
      this.logger.warn(
        new Error('Failed to drain proxy upstream mutations before stop', {
          cause: error,
        }),
      )
    })
    await proxy.stop()
    this.desired.clear()
    this.applied.clear()
    this.failures.clear()
    this.logger.info('Neem proxy stopped')
  }

  async setUpstreams(upstreams: readonly RuntimeUpstreams[]): Promise<void> {
    this.desired = createDesiredUpstreams(
      filterRuntimeUpstreams(upstreams, this.snapshot.config.runtimes),
    )
    await this.reconcile()
  }

  async waitForIdle(): Promise<void> {
    await this.mutations.waitIdle()
    const error = this.mutationError
    this.mutationError = undefined
    if (error) throw error
  }

  getHealth(): NeemProxyHealth {
    const desired = [...this.desired.values()]
    const applied = [...this.applied.values()]
    const failedUpstreams = [...this.failures.values()]
    const synced =
      desired.length === applied.length &&
      desired.every((upstream) => this.applied.has(upstreamKey(upstream)))

    return {
      enabled: true,
      running: this.running,
      ready:
        this.running &&
        this.mutations.pending === 0 &&
        failedUpstreams.length === 0 &&
        synced,
      upstreams: desired,
      appliedUpstreams: applied,
      pending: this.mutations.pending,
      failedUpstreams,
      lastError: failedUpstreams.at(-1)?.error,
    }
  }

  private async reconcile(): Promise<void> {
    if (!this.proxy) return

    const removals = [...this.applied.values()].filter(
      (upstream) => !this.desired.has(upstreamKey(upstream)),
    )
    const additions = [...this.desired.values()].filter(
      (upstream) => !this.applied.has(upstreamKey(upstream)),
    )

    await this.mutations
      .run(async () => {
        for (const upstream of removals) await this.removeUpstream(upstream)
        for (const upstream of additions) await this.addUpstream(upstream)
      })
      .catch((error) => {
        const normalized = normalizeError(error)
        this.mutationError ??= normalized
        this.logger.warn(
          new Error('Failed to reconcile proxy upstreams', {
            cause: normalized,
          }),
        )
      })
  }

  private async addUpstream(
    upstream: NeemProxyUpstreamSnapshot,
  ): Promise<void> {
    if (!this.proxy) return
    const key = upstreamKey(upstream)
    try {
      await this.proxy.addUpstream(upstream.runtimeName, upstream.proxyUpstream)
      this.applied.set(key, upstream)
      this.failures.delete(key)
      this.logger.trace(
        {
          runtimeName: upstream.runtimeName,
          upstream: upstream.upstream,
          count: upstream.count,
        },
        'Neem proxy upstream added',
      )
    } catch (error) {
      const normalized = normalizeError(error)
      this.failures.set(key, { operation: 'add', upstream, error: normalized })
      throw normalized
    }
  }

  private async removeUpstream(
    upstream: NeemProxyUpstreamSnapshot,
  ): Promise<void> {
    if (!this.proxy) return
    const key = upstreamKey(upstream)
    try {
      await this.proxy.removeUpstream(
        upstream.runtimeName,
        upstream.proxyUpstream,
      )
      this.applied.delete(key)
      this.failures.delete(key)
      this.logger.trace(
        {
          runtimeName: upstream.runtimeName,
          upstream: upstream.upstream,
          count: upstream.count,
        },
        'Neem proxy upstream removed',
      )
    } catch (error) {
      const normalized = normalizeError(error)
      this.failures.set(key, {
        operation: 'remove',
        upstream,
        error: normalized,
      })
      throw normalized
    }
  }
}

export type RuntimeUpstreams = {
  runtimeName: string
  upstreams: readonly NeemRuntimeUpstream[]
}

export function createDesiredUpstreams(
  runtimeUpstreams: readonly RuntimeUpstreams[],
): Map<string, NeemProxyUpstreamSnapshot> {
  const desired = new Map<string, NeemProxyUpstreamSnapshot>()

  for (const runtime of runtimeUpstreams) {
    for (const upstream of runtime.upstreams) {
      const normalized = normalizeRuntimeUpstream(upstream)
      const snapshot: NeemProxyUpstreamSnapshot = {
        runtimeName: runtime.runtimeName,
        upstream: normalized,
        proxyUpstream: toProxyUpstream(normalized),
        count: 1,
      }
      const key = upstreamKey(snapshot)
      const current = desired.get(key)
      if (current) current.count++
      else desired.set(key, snapshot)
    }
  }

  return desired
}

export function normalizeRuntimeUpstream(
  upstream: NeemRuntimeUpstream,
): NeemRuntimeUpstream {
  const url = new URL(upstream.url)
  if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1'
  return { type: upstream.type, url: url.toString() }
}

export function toProxyUpstream(
  upstream: NeemRuntimeUpstream,
): NeemProxyUpstream {
  const url = new URL(upstream.url)
  const secure = url.protocol === 'https:' || url.protocol === 'wss:'
  const port = url.port ? Number.parseInt(url.port, 10) : secure ? 443 : 80

  return {
    type: 'port',
    transport: upstream.type as NeemProxyUpstream['transport'],
    secure,
    hostname: url.hostname,
    port,
  }
}

export function createNativeProxyOptions(
  config: NeemProxyConfig,
  runtimes: RuntimeProxyConfigs,
): NativeProxyOptions {
  const applications = Object.entries(runtimes).flatMap(([name, runtime]) => {
    const proxy = runtime?.proxy
    if (!proxy) return []
    return [
      {
        name,
        routing: normalizeProxyRouting(name, proxy.routing),
        sni: proxy.sni,
      },
    ]
  })
  assertSingleDefaultRoute(applications)

  return {
    listen: `${config.hostname}:${config.port}`,
    tls: config.tls
      ? { keyPath: config.tls.key, certPath: config.tls.cert }
      : undefined,
    applications,
    healthCheckIntervalMs: config.healthChecks?.interval,
    stickySessions: config.stickySessions,
  }
}

function normalizeProxyRouting(
  runtimeName: string,
  routing: NeemRuntimeProxyConfig['routing'],
): NativeProxyRouting {
  if (!routing) return { type: 'path', name: runtimeName }
  if (routing.type === 'default') return { type: 'default' }

  return routing.name === undefined
    ? { type: routing.type, name: runtimeName }
    : { type: routing.type, name: routing.name }
}

function assertSingleDefaultRoute(
  applications: NativeProxyOptions['applications'],
): void {
  const defaults = applications.filter(
    (application) => application.routing.type === 'default',
  )
  if (defaults.length <= 1) return
  throw new Error(
    `Multiple Neem proxy default routes configured: ${defaults
      .map((application) => application.name)
      .join(', ')}`,
  )
}

function filterRuntimeUpstreams(
  upstreams: readonly RuntimeUpstreams[],
  runtimes: RuntimeProxyConfigs,
): readonly RuntimeUpstreams[] {
  const proxied = new Set(
    Object.entries(runtimes)
      .filter(([, runtime]) => runtime?.proxy)
      .map(([name]) => name),
  )
  return upstreams.filter((runtime) => proxied.has(runtime.runtimeName))
}

function upstreamKey(upstream: NeemProxyUpstreamSnapshot): string {
  return `${upstream.runtimeName}:${upstream.upstream.type}:${upstream.upstream.url}`
}

async function loadProxyPackage(): Promise<{ Proxy: NativeProxyConstructor }> {
  return (await import(
    process.env.NEEM_INTERNAL_PROXY_MODULE || '@nmtjs/proxy'
  )) as { Proxy: NativeProxyConstructor }
}
