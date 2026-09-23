import { createFuture } from '@nmtjs/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeSnapshot } from '../../src/internal/manifest/snapshot.ts'
import type {
  NeemProxyConfig,
  NeemProxyUpstream,
} from '../../src/shared/types.ts'
import {
  createDesiredUpstreams,
  createNativeProxyOptions,
  formatProxyListenUrl,
  normalizeRuntimeUpstream,
  ProxyController,
  toProxyUpstream,
} from '../../src/internal/host/proxy.ts'

// Mirrors the native registry, which rejects repeated adds and removals.
const native = vi.hoisted(() => ({
  registered: new Set<string>(),
  beforeMutation: async (_operation: 'add' | 'remove', _key: string) => {},
}))

vi.mock('@nmtjs/proxy', () => {
  const key = (runtimeName: string, upstream: NeemProxyUpstream) =>
    `${runtimeName}:${upstream.transport}:${upstream.hostname}:${upstream.port}`
  return {
    Proxy: class {
      async start() {}
      async stop() {}
      // stands in for the port the OS picks when `port: 0` is configured
      address() {
        return { hostname: '127.0.0.1', port: 54321 }
      }
      async addUpstream(runtimeName: string, upstream: NeemProxyUpstream) {
        const id = key(runtimeName, upstream)
        await native.beforeMutation('add', id)
        if (native.registered.has(id))
          throw new Error('Upstream already exists')
        native.registered.add(id)
      }
      async removeUpstream(runtimeName: string, upstream: NeemProxyUpstream) {
        const id = key(runtimeName, upstream)
        await native.beforeMutation('remove', id)
        if (!native.registered.delete(id)) throw new Error('Upstream not found')
      }
    },
  }
})

beforeEach(() => {
  native.registered.clear()
  native.beforeMutation = async () => {}
})

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

describe('ProxyController upstream reconciliation', () => {
  const first = { type: 'http', url: 'http://127.0.0.1:4101/' } as const
  const second = { type: 'http', url: 'http://127.0.0.1:4102/' } as const

  async function startController() {
    const noop = () => {}
    const logger = {
      info: noop,
      debug: noop,
      trace: noop,
      warn: noop,
      child: (): unknown => logger,
    }
    const controller = new ProxyController({
      logger,
      config: {
        proxy: { hostname: '127.0.0.1', port: 0 },
        runtimes: { api: { proxy: {} } },
      },
    } as unknown as RuntimeSnapshot)
    await controller.start([{ runtimeName: 'api', upstreams: [first, second] }])
    return controller
  }

  it('removes every failed worker when failures overlap a pending removal', async () => {
    const controller = await startController()
    const release = createFuture<void>()
    native.beforeMutation = async () => {
      await release.promise
    }

    const firstFailed = controller.setUpstreams([
      { runtimeName: 'api', upstreams: [second] },
    ])
    const bothFailed = controller.setUpstreams([
      { runtimeName: 'api', upstreams: [] },
    ])
    release.resolve()

    await expect(firstFailed).resolves.toBeUndefined()
    await expect(bothFailed).resolves.toBeUndefined()
    expect(native.registered.size).toBe(0)
    expect(controller.getHealth()).toMatchObject({
      appliedUpstreams: [],
      failedUpstreams: [],
      ready: true,
    })
    await controller.stop()
  })

  it('does not fail a later reconcile with an earlier reconcile error', async () => {
    const controller = await startController()
    native.beforeMutation = async (operation, key) => {
      if (operation === 'remove' && key.endsWith(':4101')) {
        throw new Error('native remove failed')
      }
    }

    await expect(
      controller.setUpstreams([{ runtimeName: 'api', upstreams: [second] }]),
    ).rejects.toThrow('native remove failed')
    expect(controller.getHealth().ready).toBe(false)

    native.beforeMutation = async () => {}
    await expect(
      controller.setUpstreams([{ runtimeName: 'api', upstreams: [second] }]),
    ).resolves.toBeUndefined()
    expect([...native.registered]).toEqual(['api:http:127.0.0.1:4102'])
    expect(controller.getHealth()).toMatchObject({
      failedUpstreams: [],
      ready: true,
    })
    await controller.stop()
  })
})
