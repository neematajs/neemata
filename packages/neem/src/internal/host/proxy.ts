import { OperationQueue } from '@nmtjs/common'

import type {
  NeemProxyHealth,
  NeemProxyUpstream,
  NeemProxyUpstreamFailure,
  NeemProxyUpstreamSnapshot,
  NeemRuntimeProxyConfig,
  NeemRuntimeUpstream,
  NeemServerConfig,
} from '../../shared/types.ts'
import type { RuntimeSnapshot } from '../manifest/snapshot.ts'
import type { HealthStatus } from './health.ts'
import { childLogger } from '../logger.ts'
import { normalizeError } from '../utils.ts'
import { resolveHealthPaths } from './health.ts'

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
  setHealth: (status: HealthStatus) => void
}

export type NativeProxyOptions = {
  listen: string
  tls?: { keyPath: string; certPath: string }
  applications: Array<{
    name: string
    routing: NativeProxyRouting
    sni?: string
    maxRequestBodySize?: number | null
  }>
  healthCheckIntervalMs?: number
  stickySessions?: NeemServerConfig['stickySessions']
  limits?: NeemServerConfig['limits']
  health: { healthPath: string; readyPath: string }
}

export type ResolvedServerConfig = NeemServerConfig & {
  hostname: string
  port: number
}

export const DEFAULT_SERVER_PORT = 3000

type NativeProxyRouting =
  | { type: 'path'; name?: string }
  | { type: 'subdomain'; name?: string }
  | { type: 'default' }

const RECONCILE_RETRY_BASE_MS = 100
const RECONCILE_RETRY_MAX_MS = 5_000

type NativeProxyConstructor = new (options: NativeProxyOptions) => NativeProxy
type RuntimeProxyConfigs = Record<
  string,
  { proxy?: NeemRuntimeProxyConfig } | undefined
>

export type ProxyControllerOptions = {
  // The host owns the health state; the proxy only serves what it is told.
  getHealthStatus?: () => HealthStatus
}

export class ProxyController {
  private readonly config: ResolvedServerConfig
  private readonly logger: RuntimeSnapshot['logger']
  private readonly mutations = new OperationQueue()
  private proxy: NativeProxy | undefined
  private running = false
  private desired = new Map<string, NeemProxyUpstreamSnapshot>()
  private applied = new Map<string, NeemProxyUpstreamSnapshot>()
  private failures = new Map<string, NeemProxyUpstreamFailure>()
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retryAttempt = 0
  // Native routing is in flux while a reconcile adds or removes upstreams,
  // even when desired and applied happen to match again.
  private mutating = false
  private publishedHealth: HealthStatus | undefined

  constructor(
    private readonly snapshot: RuntimeSnapshot,
    private readonly options: ProxyControllerOptions = {},
  ) {
    this.config = resolveServerConfig(snapshot.config.server, snapshot.mode)
    this.logger = childLogger(snapshot.logger, 'neem:server')
  }

  async start(upstreams: readonly RuntimeUpstreams[]): Promise<void> {
    if (this.proxy) return

    const ProxyConstructor = (await loadProxyPackage()).Proxy
    // A new native instance starts from its default status.
    this.publishedHealth = undefined
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
      const listen = this.resolveListenUrl()
      this.logger.info(`Neem server listening on [${listen}]`)
      this.logger.trace(
        { listen, upstreams: this.desired.size },
        'Neem server upstreams',
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
    this.cancelRetry()
    this.retryAttempt = 0
    if (!proxy) return

    this.logger.info('Neem server stopping')
    await this.mutations.waitIdle()
    await proxy.stop()
    this.desired.clear()
    this.applied.clear()
    this.failures.clear()
    this.logger.debug('Neem server stopped')
  }

  /**
   * Rejects with this call's own reconcile error. Failed reconciles are retried
   * in the background until upstreams converge or a newer call supersedes them.
   */
  async setUpstreams(upstreams: readonly RuntimeUpstreams[]): Promise<void> {
    this.desired = createDesiredUpstreams(
      filterRuntimeUpstreams(upstreams, this.snapshot.config.runtimes),
    )
    this.publishHealth()
    await this.reconcile()
  }

  /**
   * Pushes the host's health to the proxy's health endpoints. Call it whenever
   * an input of the host's health changes; unchanged status is not re-sent.
   */
  publishHealth(): void {
    const proxy = this.proxy
    const { getHealthStatus } = this.options
    if (!proxy || !this.running || !getHealthStatus) return

    const status = getHealthStatus()
    const published = this.publishedHealth
    if (
      published?.healthy === status.healthy &&
      published.ready === status.ready
    ) {
      return
    }

    try {
      proxy.setHealth(status)
      this.publishedHealth = status
      this.logger.debug(status, 'Neem server health published')
    } catch (error) {
      this.logger.warn(
        new Error('Failed to publish Neem server health', {
          cause: normalizeError(error),
        }),
      )
    }
  }

  getHealth(): NeemProxyHealth {
    const desired = [...this.desired.values()]
    const applied = [...this.applied.values()]
    const failedUpstreams = [...this.failures.values()]
    const synced =
      desired.length === applied.length &&
      desired.every((upstream) => this.applied.has(upstreamKey(upstream)))

    return {
      running: this.running,
      // A queued reconcile that changes nothing must not flap readiness.
      ready:
        this.running &&
        !this.mutating &&
        failedUpstreams.length === 0 &&
        synced,
      upstreams: desired,
      appliedUpstreams: applied,
      pending: this.mutations.pending,
      failedUpstreams,
      lastError: failedUpstreams.at(-1)?.error,
    }
  }

  /**
   * The configured port may be 0, so only the bound address tells operators
   * where the proxy actually accepts traffic. Never let reporting break start.
   */
  private resolveListenUrl(): string {
    let address: { hostname: string; port: number } | null = null
    try {
      address = this.proxy?.address() ?? null
    } catch (error) {
      this.logger.debug(
        new Error('Failed to read Neem server listen address', {
          cause: error,
        }),
      )
    }
    return formatProxyListenUrl(
      address ?? { hostname: this.config.hostname, port: this.config.port },
      Boolean(this.config.tls),
    )
  }

  private async reconcile(): Promise<void> {
    this.cancelRetry()
    if (!this.proxy) return

    await this.mutations
      .run(async () => {
        // A failed add for an upstream that is no longer desired has nothing left
        // to retry and would otherwise keep proxy health unready.
        for (const key of this.failures.keys()) {
          if (!this.desired.has(key) && !this.applied.has(key)) {
            this.failures.delete(key)
          }
        }

        // Diff when the mutation runs: reconciles queued earlier may already have
        // applied part of this change, and native add/remove reject repeats.
        const removals = [...this.applied.values()].filter(
          (upstream) => !this.desired.has(upstreamKey(upstream)),
        )
        const additions = [...this.desired.values()].filter(
          (upstream) => !this.applied.has(upstreamKey(upstream)),
        )
        if (removals.length === 0 && additions.length === 0) return

        // Upstreams are independent; one failure must not keep the rest stale.
        const errors: unknown[] = []
        const collect = (error: unknown) => {
          errors.push(error)
        }
        this.mutating = true
        try {
          for (const upstream of removals)
            await this.removeUpstream(upstream).catch(collect)
          for (const upstream of additions)
            await this.addUpstream(upstream).catch(collect)
        } finally {
          this.mutating = false
        }
        if (errors.length > 0) throw errors[0]
      })
      .then(
        () => {
          // A later reconcile converged, so any retry scheduled by an earlier one is moot.
          this.cancelRetry()
          this.retryAttempt = 0
          this.publishHealth()
        },
        (error) => {
          const normalized = normalizeError(error)
          this.logger.warn(
            new Error('Failed to reconcile proxy upstreams', {
              cause: normalized,
            }),
          )
          this.scheduleRetry()
          this.publishHealth()
          throw normalized
        },
      )
  }

  // Failure and recovery refreshes may be the last lifecycle event for a while,
  // so a transient native error must not leave routing stale until the next one.
  private scheduleRetry(): void {
    this.cancelRetry()
    if (!this.proxy) return
    const delay = Math.min(
      RECONCILE_RETRY_BASE_MS * 2 ** this.retryAttempt,
      RECONCILE_RETRY_MAX_MS,
    )
    this.retryAttempt++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.reconcile().catch(() => undefined)
    }, delay)
    this.retryTimer.unref()
  }

  private cancelRetry(): void {
    if (!this.retryTimer) return
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
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
    transport: upstream.type,
    secure,
    hostname: url.hostname,
    port,
  }
}

export function formatProxyListenUrl(
  address: { hostname: string; port: number },
  secure: boolean,
): string {
  // Bare IPv6 addresses need brackets to stay a valid URL authority
  const hostname = address.hostname.includes(':')
    ? `[${address.hostname}]`
    : address.hostname
  return `${secure ? 'https' : 'http'}://${hostname}:${address.port}`
}

export function resolveServerConfig(
  config: NeemServerConfig | undefined,
  mode: RuntimeSnapshot['mode'],
): ResolvedServerConfig {
  return {
    ...config,
    // Production must be reachable by platform probes and load balancers.
    hostname:
      config?.hostname ?? (mode === 'production' ? '0.0.0.0' : '127.0.0.1'),
    port: config?.port ?? DEFAULT_SERVER_PORT,
  }
}

export function createNativeProxyOptions(
  config: ResolvedServerConfig,
  runtimes: RuntimeProxyConfigs,
): NativeProxyOptions {
  const applications: NativeProxyOptions['applications'] = []
  for (const name in runtimes) {
    if (!Object.hasOwn(runtimes, name)) continue
    const proxy = runtimes[name]?.proxy
    if (!proxy) continue

    const routing = normalizeProxyRouting(name, proxy.routing)
    applications.push({
      name,
      routing,
      sni: proxy.sni,
      maxRequestBodySize: proxy.maxRequestBodySize,
    })
  }
  assertSingleDefaultRoute(applications)

  return {
    listen: `${config.hostname}:${config.port}`,
    tls: config.tls,
    applications,
    healthCheckIntervalMs: config.upstreamChecks?.interval,
    stickySessions: config.stickySessions,
    limits: config.limits,
    health: createNativeHealthOptions(config.health),
  }
}

function createNativeHealthOptions(
  health: NeemServerConfig['health'],
): NativeProxyOptions['health'] {
  const paths = resolveHealthPaths(health)
  return { healthPath: paths.health, readyPath: paths.ready }
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
  const defaults: string[] = []
  for (const { name, routing } of applications) {
    if (routing.type === 'default') defaults.push(name)
  }
  if (defaults.length <= 1) return
  throw new Error(
    `Multiple Neem proxy default routes configured: ${defaults.join(', ')}`,
  )
}

function filterRuntimeUpstreams(
  upstreams: readonly RuntimeUpstreams[],
  runtimes: RuntimeProxyConfigs,
): readonly RuntimeUpstreams[] {
  const proxied = new Set<string>()
  for (const name in runtimes) {
    if (Object.hasOwn(runtimes, name) && runtimes[name]?.proxy) {
      proxied.add(name)
    }
  }
  return upstreams.filter((runtime) => proxied.has(runtime.runtimeName))
}

function upstreamKey(upstream: NeemProxyUpstreamSnapshot): string {
  return `${upstream.runtimeName}:${upstream.upstream.type}:${upstream.upstream.url}`
}

// Built host code runs from the app's output directory, so the native package
// must resolve from the app itself; neem declares it as a peer for that reason.
async function loadProxyPackage(): Promise<{ Proxy: NativeProxyConstructor }> {
  const specifier = process.env.NEEM_INTERNAL_PROXY_MODULE || '@nmtjs/proxy'
  try {
    return (await import(specifier)) as { Proxy: NativeProxyConstructor }
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ERR_MODULE_NOT_FOUND') {
      throw error
    }
    throw new Error(
      `Neem cannot load its server package [${specifier}]; add @nmtjs/proxy to your app's dependencies`,
      { cause: error },
    )
  }
}
