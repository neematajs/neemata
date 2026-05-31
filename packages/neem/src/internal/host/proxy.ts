import { OperationQueue } from '@nmtjs/common'

import type { NeemProxyConfig } from '../../public/config.ts'
import type {
  NeemProxyHealth,
  NeemProxyUpstream,
  NeemProxyUpstreamFailure,
  NeemProxyUpstreamSnapshot,
  NeemRuntimeUpstream,
} from '../../public/runtime.ts'
import type { RuntimeSnapshot } from '../manifest/snapshot.ts'
import { childLogger } from '../shared/logger.ts'
import { normalizeError } from '../shared/utils.ts'

export type NativeProxy = {
  start: () => Promise<void>
  stop: () => Promise<void>
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
    routing: { type?: 'subdomain' | 'path'; name?: string; default?: boolean }
    sni?: string
  }>
  healthCheckIntervalMs?: number
  stickySessions?: NeemProxyConfig['stickySessions']
}

type NativeProxyConstructor = new (options: NativeProxyOptions) => NativeProxy

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
      createNativeProxyOptions(
        this.config,
        Object.keys(this.snapshot.manifest.runtimes),
      ),
    )
    this.desired = createDesiredUpstreams(upstreams)

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
    this.desired = createDesiredUpstreams(upstreams)
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
  runtimeNames: readonly string[],
): NativeProxyOptions {
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

function upstreamKey(upstream: NeemProxyUpstreamSnapshot): string {
  return `${upstream.runtimeName}:${upstream.upstream.type}:${upstream.upstream.url}`
}

async function loadProxyPackage(): Promise<{ Proxy: NativeProxyConstructor }> {
  return (await import(
    process.env.NEEM_INTERNAL_PROXY_MODULE || '@nmtjs/proxy'
  )) as { Proxy: NativeProxyConstructor }
}
