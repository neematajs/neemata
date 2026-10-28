import type {
  NeemProxyUpstream,
  NeemProxyUpstreamSnapshot,
  NeemRuntimeProxyConfig,
  NeemRuntimeUpstream,
  NeemServerConfig,
} from '../../shared/types.ts'
import type { RuntimeSnapshot } from '../manifest/snapshot.ts'
import { resolveHealthPaths, type HealthStatus } from './health.ts'
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
  threads?: number
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

export type NativeProxyConstructor = new (
  options: NativeProxyOptions,
) => NativeProxy
export type RuntimeProxyConfigs = Record<
  string,
  { proxy?: NeemRuntimeProxyConfig } | undefined
>

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
    threads: config.threads,
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

export function filterRuntimeUpstreams(
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

export function upstreamKey(upstream: NeemProxyUpstreamSnapshot): string {
  return `${upstream.runtimeName}:${upstream.upstream.type}:${upstream.upstream.url}`
}

// Built host code runs from the app's output directory, so the native package
// must resolve from the app itself; neem declares it as a peer for that reason.
export async function loadProxyPackage(): Promise<{
  Proxy: NativeProxyConstructor
}> {
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
