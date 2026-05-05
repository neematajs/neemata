import { describe, expect, it } from 'vitest'

import type { NeemProxyUpstreamRegistryEvent } from '../../../packages/neem/src/internal/proxy-upstreams.ts'
import {
  NeemProxyUpstreamRegistry,
  normalizeProxyApplicationUpstream,
  toProxyUpstream,
} from '../../../packages/neem/src/internal/proxy-upstreams.ts'

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
})
