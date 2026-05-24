import { describe, expect, it } from 'vitest'

import type { NeemBuildManifest } from '../../../packages/neem/src/internal/build/manifest.ts'
import type { NeemProxyUpstreamRegistryEvent } from '../../../packages/neem/src/internal/runtime/proxy.ts'
import {
  createNativeProxyOptions,
  NeemProxyUpstreamRegistry,
  normalizeProxyRuntimeUpstream,
  toProxyUpstream,
} from '../../../packages/neem/src/internal/runtime/proxy.ts'
import { createRuntimeSnapshot } from '../../../packages/neem/src/internal/runtime/snapshot.ts'

describe('neem proxy upstream registry', () => {
  it('normalizes wildcard hosts and maps runtime upstreams to proxy upstreams', () => {
    const upstream = normalizeProxyRuntimeUpstream({
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
        runtimeName: 'api',
        count: 2,
        upstream: { type: 'http', url: 'http://127.0.0.1:4101/api/0' },
      }),
    ])
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('add')

    registry.removeOwnerUpstreams(workerA)
    expect(registry.list()).toEqual([
      expect.objectContaining({ runtimeName: 'api', count: 1 }),
    ])
    expect(events).toHaveLength(1)

    registry.removeOwnerUpstreams(workerB)
    expect(registry.list()).toEqual([])
    expect(events).toEqual([
      expect.objectContaining({ type: 'add' }),
      expect.objectContaining({ type: 'remove' }),
    ])
  })

  it('creates native proxy options from Neem proxy config', () => {
    const snapshot = createProxySnapshot()
    const options = createNativeProxyOptions(snapshot.config.proxy!, ['api'])

    expect(options).toMatchObject({
      listen: '127.0.0.1:4090',
      applications: [{ name: 'api', routing: { type: 'path', name: 'api' } }],
      healthCheckIntervalMs: 250,
    })
  })

  it('omits configured proxy routes for runtimes outside selected manifest', () => {
    const options = createNativeProxyOptions(
      {
        hostname: '127.0.0.1',
        port: 4090,
        runtimes: {
          api: { routing: { type: 'path', name: 'api' } },
          jobs: { routing: { type: 'path', name: 'jobs' } },
        },
      },
      ['api'],
    )

    expect(options.applications).toEqual([
      { name: 'api', routing: { type: 'path', name: 'api' } },
    ])
  })
})

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
      runtimes: {},
    },
    manifest: createManifest(),
  })
}

function createManifest(): NeemBuildManifest {
  return {
    schemaVersion: 1,
    config: { file: 'config/entry/neem.config.js' },
    runtimes: {
      api: {
        name: 'api',
        entry: {
          id: 'entry',
          kind: 'worker',
          owner: { type: 'runtime', name: 'api' },
          file: 'runtimes/api/entry/api.js',
          outDir: 'runtimes/api/entry',
        },
        artifacts: [],
      },
    },
  }
}
