import { describe, expect, it } from 'vitest'

import type { NeemProxyConfig } from '../src/shared/types.ts'
import {
  createDesiredUpstreams,
  createNativeProxyOptions,
  normalizeRuntimeUpstream,
  toProxyUpstream,
} from '../src/internal/host/proxy.ts'

describe('Neem proxy helpers', () => {
  it('normalizes wildcard runtime upstreams to loopback', () => {
    expect(
      normalizeRuntimeUpstream({ type: 'http', url: 'http://0.0.0.0:3000' }),
    ).toEqual({ type: 'http', url: 'http://127.0.0.1:3000/' })
  })

  it('converts runtime upstream URLs to native proxy upstreams', () => {
    expect(
      toProxyUpstream({ type: 'http', url: 'http://127.0.0.1/api' }),
    ).toEqual({
      type: 'port',
      transport: 'http',
      secure: false,
      hostname: '127.0.0.1',
      port: 80,
    })
    expect(
      toProxyUpstream({ type: 'ws', url: 'wss://example.com/socket' }),
    ).toEqual({
      type: 'port',
      transport: 'ws',
      secure: true,
      hostname: 'example.com',
      port: 443,
    })
  })

  it('deduplicates desired upstream snapshots and tracks counts per runtime', () => {
    const desired = createDesiredUpstreams([
      {
        runtimeName: 'api',
        upstreams: [
          { type: 'http', url: 'http://0.0.0.0:3000' },
          { type: 'http', url: 'http://127.0.0.1:3000/' },
        ],
      },
      {
        runtimeName: 'jobs',
        upstreams: [{ type: 'http', url: 'http://127.0.0.1:3000/' }],
      },
    ])

    expect([...desired.values()]).toEqual([
      expect.objectContaining({ runtimeName: 'api', count: 2 }),
      expect.objectContaining({ runtimeName: 'jobs', count: 1 }),
    ])
  })

  it('creates native proxy options from active manifest runtimes', () => {
    const config: NeemProxyConfig = {
      hostname: '127.0.0.1',
      port: 8080,
      runtimes: {
        api: {
          routing: { type: 'subdomain', name: 'api' },
          sni: 'api.localhost',
        },
        inactive: { routing: { type: 'path', name: 'inactive' } },
      },
      healthChecks: { interval: 250 },
      stickySessions: { enabled: true, cookieName: 'sid' },
      tls: { key: '/certs/key.pem', cert: '/certs/cert.pem' },
    }

    expect(createNativeProxyOptions(config, ['api', 'jobs'])).toEqual({
      listen: '127.0.0.1:8080',
      tls: { keyPath: '/certs/key.pem', certPath: '/certs/cert.pem' },
      applications: [
        {
          name: 'api',
          routing: { type: 'subdomain', name: 'api' },
          sni: 'api.localhost',
        },
      ],
      healthCheckIntervalMs: 250,
      stickySessions: { enabled: true, cookieName: 'sid' },
    })
  })

  it('defaults proxy routing for every active runtime when no runtime map exists', () => {
    expect(
      createNativeProxyOptions({ hostname: '0.0.0.0', port: 80 }, [
        'api',
        'jobs',
      ]).applications,
    ).toEqual([
      { name: 'api', routing: { type: 'path', name: 'api' }, sni: undefined },
      { name: 'jobs', routing: { type: 'path', name: 'jobs' }, sni: undefined },
    ])
  })
})
