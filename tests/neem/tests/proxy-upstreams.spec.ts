import { describe, expect, it } from 'vitest'

import type { NeemBuildManifest } from '../../../packages/neem/src/internal/build/manifest.ts'
import type {
  NeemNativeProxy,
  NeemNativeProxyOptions,
  NeemProxyUpstreamRegistryEvent,
} from '../../../packages/neem/src/internal/runtime/proxy.ts'
import {
  NeemProxyManager,
  NeemProxyUpstreamRegistry,
  normalizeProxyApplicationUpstream,
  toProxyUpstream,
} from '../../../packages/neem/src/internal/runtime/proxy.ts'
import { createRuntimeSnapshot } from '../../../packages/neem/src/internal/runtime/snapshot.ts'

describe('neem proxy upstream registry', () => {
  it('normalizes wildcard hosts and maps app upstreams to proxy upstreams', () => {
    const upstream = normalizeProxyApplicationUpstream({
      type: 'http',
      url: 'http://0.0.0.0:4101/api/0',
    })

    expect(upstream).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:4101/api/0',
    })
    expect(toProxyUpstream(upstream)).toEqual({
      type: 'port',
      transport: 'http',
      secure: false,
      hostname: '127.0.0.1',
      port: 4101,
    })
  })

  it('uses protocol default ports for proxy upstreams', () => {
    expect(
      toProxyUpstream({ type: 'http', url: 'http://example.test/api' }),
    ).toMatchObject({ secure: false, hostname: 'example.test', port: 80 })
    expect(
      toProxyUpstream({ type: 'http', url: 'https://example.test/api' }),
    ).toMatchObject({ secure: true, hostname: 'example.test', port: 443 })
    expect(
      toProxyUpstream({ type: 'ws', url: 'wss://example.test/socket' }),
    ).toMatchObject({ secure: true, hostname: 'example.test', port: 443 })
  })

  it('refcounts duplicate upstreams across worker owners', () => {
    const registry = new NeemProxyUpstreamRegistry()
    const workerA = {}
    const workerB = {}
    const events: Array<{
      type: 'add' | 'remove'
      event: NeemProxyUpstreamRegistryEvent
    }> = []
    registry.on('add', (event) => events.push({ type: 'add', event }))
    registry.on('remove', (event) => events.push({ type: 'remove', event }))

    const upstreams = [{ type: 'http', url: 'http://0.0.0.0:4101/api/0' }]
    registry.addOwnerUpstreams(workerA, 'api', upstreams)
    registry.addOwnerUpstreams(workerB, 'api', upstreams)

    expect(registry.list()).toEqual([
      expect.objectContaining({
        appName: 'api',
        count: 2,
        upstream: { type: 'http', url: 'http://127.0.0.1:4101/api/0' },
      }),
    ])
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('add')

    registry.removeOwnerUpstreams(workerA)
    expect(registry.list()).toEqual([
      expect.objectContaining({ appName: 'api', count: 1 }),
    ])
    expect(events).toHaveLength(1)

    registry.removeOwnerUpstreams(workerB)
    expect(registry.list()).toEqual([])
    expect(events).toEqual([
      expect.objectContaining({ type: 'add' }),
      expect.objectContaining({ type: 'remove' }),
    ])
  })

  it('starts optional native proxy lazily and syncs current + future upstreams', async () => {
    const upstreams = new NeemProxyUpstreamRegistry()
    const owner = {}
    upstreams.addOwnerUpstreams(owner, 'api', [
      { type: 'http', url: 'http://0.0.0.0:4101/api/0' },
    ])

    const created: FakeNativeProxy[] = []
    const manager = new NeemProxyManager({
      snapshot: createProxySnapshot(),
      upstreams,
      loadProxyPackage: async () => ({
        Proxy: class extends FakeNativeProxy {
          constructor(options: NeemNativeProxyOptions) {
            super(options)
            created.push(this)
          }
        },
      }),
    })

    await manager.start()
    const proxy = created[0]!
    expect(proxy.options).toMatchObject({
      listen: '127.0.0.1:4090',
      applications: [{ name: 'api', routing: { type: 'path', name: 'api' } }],
      healthCheckIntervalMs: 250,
    })
    expect(proxy.events).toEqual(['add:api:http:127.0.0.1:4101', 'start'])

    const nextOwner = {}
    upstreams.addOwnerUpstreams(nextOwner, 'api', [
      { type: 'ws', url: 'ws://127.0.0.1:4102/ws' },
    ])
    await wait()
    expect(proxy.events).toContain('add:api:ws:127.0.0.1:4102')

    upstreams.removeOwnerUpstreams(owner)
    await wait()
    expect(proxy.events).toContain('remove:api:http:127.0.0.1:4101')

    await manager.stop()
    upstreams.removeOwnerUpstreams(nextOwner)
    await wait()
    expect(proxy.events.at(-1)).toBe('stop')
  })
})

class FakeNativeProxy implements NeemNativeProxy {
  readonly events: string[] = []

  constructor(readonly options: NeemNativeProxyOptions) {}

  async start(): Promise<undefined> {
    this.events.push('start')
  }

  async stop(): Promise<undefined> {
    this.events.push('stop')
  }

  async addUpstream(
    appName: string,
    upstream: Parameters<NeemNativeProxy['addUpstream']>[1],
  ): Promise<undefined> {
    this.events.push(
      `add:${appName}:${upstream.transport}:${upstream.hostname}:${upstream.port}`,
    )
  }

  async removeUpstream(
    appName: string,
    upstream: Parameters<NeemNativeProxy['removeUpstream']>[1],
  ): Promise<undefined> {
    this.events.push(
      `remove:${appName}:${upstream.transport}:${upstream.hostname}:${upstream.port}`,
    )
  }
}

function createProxySnapshot() {
  return createRuntimeSnapshot({
    mode: 'production',
    outDir: '/tmp/neem-out',
    config: {
      proxy: {
        hostname: '127.0.0.1',
        port: 4090,
        healthChecks: { interval: 250 },
      },
      apps: {},
    },
    manifest: createManifest(),
  })
}

function createManifest(): NeemBuildManifest {
  return {
    schemaVersion: 1,
    config: { file: 'config/entry/neem.config.js' },
    apps: {
      api: {
        name: 'api',
        entry: {
          id: 'entry',
          kind: 'module',
          owner: { type: 'app', name: 'api' },
          file: 'apps/api/entry/api.js',
          outDir: 'apps/api/entry',
        },
      },
    },
    plugins: [],
  }
}

function wait(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
