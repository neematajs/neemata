import type {
  NeemProxyUpstream,
  NeemProxyUpstreamSnapshot,
  NeemRuntimeUpstream,
} from '../../public/runtime.ts'

export type {
  NeemProxyUpstream,
  NeemProxyUpstreamSnapshot,
} from '../../public/runtime.ts'

export type NeemProxyUpstreamRegistryEvent = NeemProxyUpstreamSnapshot

type Listener = (event: NeemProxyUpstreamRegistryEvent) => void

type RegistryEntry = {
  upstream: NeemRuntimeUpstream
  proxyUpstream: NeemProxyUpstream
  count: number
}

export class NeemProxyUpstreamRegistry {
  private readonly upstreams = new Map<string, Map<string, RegistryEntry>>()
  private readonly upstreamsByOwner = new WeakMap<
    object,
    Array<{ runtimeName: string; key: string }>
  >()
  private readonly listeners = {
    add: new Set<Listener>(),
    remove: new Set<Listener>(),
  }

  addOwnerUpstreams(
    owner: object,
    runtimeName: string,
    upstreams: readonly NeemRuntimeUpstream[],
  ): void {
    this.removeOwnerUpstreams(owner)

    const keys: Array<{ runtimeName: string; key: string }> = []
    for (const upstream of upstreams) {
      const normalized = normalizeProxyRuntimeUpstream(upstream)
      const proxyUpstream = toProxyUpstream(normalized)
      const key = getProxyRuntimeUpstreamKey(normalized)
      keys.push({ runtimeName, key })
      this.addUpstream(runtimeName, key, normalized, proxyUpstream)
    }

    if (keys.length > 0) {
      this.upstreamsByOwner.set(owner, keys)
    }
  }

  removeOwnerUpstreams(owner: object): void {
    const keys = this.upstreamsByOwner.get(owner)
    if (!keys) return
    this.upstreamsByOwner.delete(owner)

    for (const { runtimeName, key } of keys) {
      const runtimeUpstreams = this.upstreams.get(runtimeName)
      const current = runtimeUpstreams?.get(key)
      if (!current) continue

      current.count--
      if (current.count > 0) continue

      runtimeUpstreams?.delete(key)
      this.emit('remove', {
        runtimeName,
        upstream: current.upstream,
        proxyUpstream: current.proxyUpstream,
        count: 0,
      })
      if (runtimeUpstreams && runtimeUpstreams.size === 0) {
        this.upstreams.delete(runtimeName)
      }
    }
  }

  *list(runtimeName?: string): IterableIterator<NeemProxyUpstreamSnapshot> {
    if (runtimeName !== undefined) {
      yield* this.listRuntime(runtimeName)
      return
    }

    for (const name of this.upstreams.keys()) {
      yield* this.listRuntime(name)
    }
  }

  private *listRuntime(
    runtimeName: string,
  ): IterableIterator<NeemProxyUpstreamSnapshot> {
    const upstreams = this.upstreams.get(runtimeName)
    if (!upstreams) return

    for (const entry of upstreams.values()) {
      yield {
        runtimeName,
        upstream: entry.upstream,
        proxyUpstream: entry.proxyUpstream,
        count: entry.count,
      }
    }
  }

  on(event: 'add' | 'remove', listener: Listener): () => void {
    this.listeners[event].add(listener)
    return () => {
      this.listeners[event].delete(listener)
    }
  }

  private addUpstream(
    runtimeName: string,
    key: string,
    upstream: NeemRuntimeUpstream,
    proxyUpstream: NeemProxyUpstream,
  ): void {
    let runtimeUpstreams = this.upstreams.get(runtimeName)
    if (!runtimeUpstreams) {
      runtimeUpstreams = new Map()
      this.upstreams.set(runtimeName, runtimeUpstreams)
    }

    const current = runtimeUpstreams.get(key)
    if (current) {
      current.count++
      return
    }

    runtimeUpstreams.set(key, { upstream, proxyUpstream, count: 1 })
    this.emit('add', { runtimeName, upstream, proxyUpstream, count: 1 })
  }

  private emit(event: 'add' | 'remove', data: NeemProxyUpstreamRegistryEvent) {
    for (const listener of this.listeners[event]) {
      listener(data)
    }
  }
}

export function normalizeProxyRuntimeUpstream(
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

export function getProxyRuntimeUpstreamKey(
  upstream: NeemRuntimeUpstream,
): string {
  return `${upstream.type}:${upstream.url}`
}
