import type { NeemApplicationUpstream } from '../../public/runtime.ts'

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
