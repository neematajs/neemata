import { describe, expect, it, vi } from 'vitest'

import type { RuntimeSnapshot } from '../../src/internal/manifest/snapshot.ts'
import type { NeemProxyConfig } from '../../src/shared/types.ts'
import {
  createDesiredUpstreams,
  createNativeProxyOptions,
  formatProxyListenUrl,
  normalizeRuntimeUpstream,
  ProxyController,
  toProxyUpstream,
} from '../../src/internal/host/proxy.ts'

vi.mock('@nmtjs/proxy', () => ({
  Proxy: class {
    async start() {}
    async stop() {}
    // stands in for the port the OS picks when `port: 0` is configured
    address() {
      return { hostname: '127.0.0.1', port: 54321 }
    }
    async addUpstream() {}
    async removeUpstream() {}
  },
}))

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

  it('keeps http and ws upstreams sharing one URL as distinct entries', () => {
    // a shared-server transport setup reports the same bound address under
    // both proxyable types; merging them would drop one routing table entry
    const url = 'http://127.0.0.1:3000/'
    const desired = createDesiredUpstreams([
      {
        runtimeName: 'api',
        upstreams: [
          { type: 'http', url },
          { type: 'ws', url },
        ],
      },
    ])

    expect([...desired.values()]).toEqual([
      expect.objectContaining({
        runtimeName: 'api',
        count: 1,
        upstream: { type: 'http', url },
        proxyUpstream: expect.objectContaining({ transport: 'http' }),
      }),
      expect.objectContaining({
        runtimeName: 'api',
        count: 1,
        upstream: { type: 'ws', url },
        proxyUpstream: expect.objectContaining({ transport: 'ws' }),
      }),
    ])
  })

  it('creates native proxy options from active manifest runtimes', () => {
    const config: NeemProxyConfig = {
      hostname: '127.0.0.1',
      port: 8080,
      healthChecks: { interval: 250 },
      stickySessions: { enabled: true, cookieName: 'sid' },
      tls: { keyPath: '/certs/key.pem', certPath: '/certs/cert.pem' },
    }

    expect(
      createNativeProxyOptions(config, {
        api: {
          proxy: {
            routing: { type: 'subdomain', name: 'api' },
            sni: 'api.localhost',
          },
        },
        jobs: {},
        defaulted: { proxy: { routing: { type: 'default' } } },
        conventional: { proxy: { routing: { type: 'path' } } },
      }),
    ).toEqual({
      listen: '127.0.0.1:8080',
      tls: { keyPath: '/certs/key.pem', certPath: '/certs/cert.pem' },
      applications: [
        {
          name: 'api',
          routing: { type: 'subdomain', name: 'api' },
          sni: 'api.localhost',
        },
        { name: 'defaulted', routing: { type: 'default' }, sni: undefined },
        {
          name: 'conventional',
          routing: { type: 'path', name: 'conventional' },
          sni: undefined,
        },
      ],
      healthCheckIntervalMs: 250,
      stickySessions: { enabled: true, cookieName: 'sid' },
    })
  })

  it('does not expose runtimes without explicit runtime proxy config', () => {
    expect(
      createNativeProxyOptions(
        { hostname: '0.0.0.0', port: 80 },
        { api: {}, jobs: {} },
      ).applications,
    ).toEqual([])
  })

  it('formats the bound proxy listen address', () => {
    expect(
      formatProxyListenUrl({ hostname: '127.0.0.1', port: 8080 }, false),
    ).toBe('http://127.0.0.1:8080')
    expect(formatProxyListenUrl({ hostname: '0.0.0.0', port: 443 }, true)).toBe(
      'https://0.0.0.0:443',
    )
    expect(formatProxyListenUrl({ hostname: '::1', port: 8080 }, false)).toBe(
      'http://[::1]:8080',
    )
  })

  it('logs the bound listen address instead of the configured port', async () => {
    const messages: string[] = []
    const noop = () => {}
    const logger = {
      info: (message: string) => {
        messages.push(message)
      },
      debug: noop,
      trace: noop,
      warn: noop,
      // annotated to keep the self-reference out of type inference
      child: (): unknown => logger,
    }

    const controller = new ProxyController({
      logger,
      config: {
        proxy: { hostname: '0.0.0.0', port: 0 },
        runtimes: { api: { proxy: { routing: { type: 'default' } } } },
      },
    } as unknown as RuntimeSnapshot)

    await controller.start([
      {
        runtimeName: 'api',
        upstreams: [{ type: 'http', url: 'http://0.0.0.0:3000' }],
      },
    ])
    await controller.stop()

    expect(messages).toContain(
      'Neem proxy listening on [http://127.0.0.1:54321]',
    )
  })

  it('rejects multiple default proxy routes', () => {
    expect(() =>
      createNativeProxyOptions(
        { hostname: '0.0.0.0', port: 80 },
        {
          api: { proxy: { routing: { type: 'default' } } },
          jobs: { proxy: { routing: { type: 'default' } } },
        },
      ),
    ).toThrow('Multiple Neem proxy default routes configured')
  })
})
