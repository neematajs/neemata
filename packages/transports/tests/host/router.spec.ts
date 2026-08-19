import type { Hooks } from 'crossws'
import { describe, expect, it, vi } from 'vitest'

import type { ServerRoute } from '../../src/host.ts'
import type {
  ServerFetchHandler,
  ServerNativeHandles,
} from '../../src/types.ts'
import { BaseServerHost } from '../../src/host.ts'

/**
 * Minimal host over the shared router: every runtime host inherits exactly
 * this routing behavior from BaseServerHost, so conformance proven here is
 * runtime parity by construction.
 */
class TestServerHost extends BaseServerHost<'node'> {
  readonly runtime = 'node' as const

  get native(): ServerNativeHandles {
    return {}
  }

  protected bind(): Promise<string> {
    return Promise.resolve('test://bound')
  }

  protected close(): Promise<void> {
    return Promise.resolve()
  }

  routeFor(pathname: string, upgrade: boolean): ServerRoute {
    return this.route(pathname, upgrade)
  }

  dispatch(request: Request): Promise<Response> {
    return this.dispatchFetch(request)
  }

  upgradeFallback(pathname: string): Response {
    return this.respondToUpgrade(pathname)
  }

  adapterConfig() {
    return this.createWsAdapterConfig()
  }
}

const createTestHost = () => new TestServerHost({ listen: { port: 0 } })

const serverRequest = (pathname: string): Request =>
  new Request(`http://localhost${pathname}`)

describe('server host router', () => {
  it('routes reserved, fetch, upgrade and unmatched pathnames from one table', () => {
    const host = createTestHost()
    const fetchHandlers = new Map<ServerFetchHandler, string>()
    for (const path of ['/', '/rpc', '/rpc/admin'] as const) {
      const handler: ServerFetchHandler = async () => new Response(path)
      fetchHandlers.set(handler, path)
      host.mountFetchHandler({ path, handler })
    }
    for (const path of ['/ws', '/ws/admin', '/events'] as const) {
      host.mountWebSocket({ path, hooks: {} })
    }

    const describeRoute = (route: ServerRoute): string => {
      switch (route.kind) {
        case 'fetch':
          return `fetch:${fetchHandlers.get(route.handler)}`
        case 'upgrade':
          return `upgrade:${route.registration.path}`
        default:
          return route.kind
      }
    }

    const cases: [pathname: string, upgrade: boolean, expected: string][] = [
      // reserved paths win over everything, for both request kinds
      ['/healthy', false, 'reserved'],
      ['/healthy', true, 'reserved'],
      // longest-prefix match on segment boundaries
      ['/rpc', false, 'fetch:/rpc'],
      ['/rpc/nested', false, 'fetch:/rpc'],
      ['/rpc/admin', false, 'fetch:/rpc/admin'],
      ['/rpc/admin/deep', false, 'fetch:/rpc/admin'],
      // a shared prefix without a segment boundary is not a match
      ['/rpcish', false, 'fetch:/'],
      ['/anything', false, 'fetch:/'],
      // fetch and WebSocket routing tables are independent
      ['/ws', false, 'fetch:/'],
      ['/rpc', true, 'none'],
      ['/ws', true, 'upgrade:/ws'],
      ['/ws/room-1', true, 'upgrade:/ws'],
      ['/ws/admin/room-1', true, 'upgrade:/ws/admin'],
      ['/wsish', true, 'none'],
      ['/events', true, 'upgrade:/events'],
      ['/missing', true, 'none'],
    ]
    for (const [pathname, upgrade, expected] of cases) {
      expect(
        describeRoute(host.routeFor(pathname, upgrade)),
        `route(${pathname}, upgrade=${upgrade})`,
      ).toBe(expected)
    }
  })

  it('returns none for everything except reserved paths when nothing is mounted', () => {
    const host = createTestHost()
    expect(host.routeFor('/healthy', false).kind).toBe('reserved')
    expect(host.routeFor('/healthy', true).kind).toBe('reserved')
    expect(host.routeFor('/', false).kind).toBe('none')
    expect(host.routeFor('/anything', true).kind).toBe('none')
  })

  it('matches a root mount against every pathname', () => {
    const host = createTestHost()
    host.mountWebSocket({ path: '/', hooks: {} })
    for (const pathname of ['/', '/ws', '/deeply/nested/path']) {
      expect(host.routeFor(pathname, true).kind).toBe('upgrade')
    }
    expect(host.routeFor('/healthy', true).kind).toBe('reserved')
  })

  it('dispatches plain requests to the routed handler with reserved/404/500 fallbacks', async () => {
    const host = createTestHost()
    host.mountFetchHandler({
      path: '/rpc',
      handler: async (request) =>
        new Response(`rpc:${new URL(request.url).pathname}`),
    })
    host.mountFetchHandler({
      path: '/broken',
      handler: () => {
        throw new Error('handler exploded')
      },
    })

    const healthy = await host.dispatch(serverRequest('/healthy'))
    expect(healthy.status).toBe(200)

    const routed = await host.dispatch(serverRequest('/rpc/nested'))
    expect(await routed.text()).toBe('rpc:/rpc/nested')

    expect((await host.dispatch(serverRequest('/missing'))).status).toBe(404)

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect((await host.dispatch(serverRequest('/broken'))).status).toBe(500)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('answers unroutable upgrade requests with reserved responses or 404', () => {
    const host = createTestHost()
    host.mountWebSocket({ path: '/ws', hooks: {} })

    expect(host.upgradeFallback('/healthy').status).toBe(200)
    expect(host.upgradeFallback('/missing').status).toBe(404)
    // even a routable WebSocket path gets a 404 here: this fallback runs only
    // when the runtime could not hand the request to a WebSocket route
    expect(host.upgradeFallback('/ws').status).toBe(404)
  })

  it('drives the crossws adapter gate and hook resolution through route()', () => {
    const host = createTestHost()
    const wsHooks: Partial<Hooks> = { message: vi.fn() }
    host.mountWebSocket({ path: '/ws', hooks: wsHooks })

    const config = host.adapterConfig()
    const upgrade = config.hooks.upgrade as (
      request: Request,
    ) => Response | undefined

    expect(upgrade(new Request('http://localhost/healthy'))?.status).toBe(200)
    // undefined lets the adapter proceed with the actual upgrade
    expect(upgrade(new Request('http://localhost/ws/room'))).toBeUndefined()
    expect(upgrade(new Request('http://localhost/missing'))?.status).toBe(404)

    expect(config.resolve({ url: 'http://localhost/ws/room' })).toBe(wsHooks)
    expect(config.resolve({ url: 'http://localhost/missing' })).toStrictEqual(
      {},
    )
  })

  it('validates mount paths', () => {
    const host = createTestHost()
    const handler: ServerFetchHandler = async () => new Response('ok')

    for (const path of ['rpc', '', '/rpc?query', '/rpc#hash'] as any[]) {
      expect(
        () => host.mountFetchHandler({ path, handler }),
        `path ${JSON.stringify(path)}`,
      ).toThrow('absolute URL pathname')
      expect(
        () => host.mountWebSocket({ path, hooks: {} }),
        `path ${JSON.stringify(path)}`,
      ).toThrow('absolute URL pathname')
    }
    expect(() => host.mountFetchHandler({ path: '/rpc/', handler })).toThrow(
      'trailing slash',
    )
    expect(() => host.mountWebSocket({ path: '/ws/', hooks: {} })).toThrow(
      'trailing slash',
    )
    // the root path is a valid mount, not a trailing slash
    expect(() => host.mountFetchHandler({ path: '/', handler })).not.toThrow()
  })

  it('rejects mounts on a started host until it fully stops', async () => {
    const host = createTestHost()
    await host.start()
    expect(() =>
      host.mountFetchHandler({
        path: '/late',
        handler: async () => new Response('no'),
      }),
    ).toThrow('started server')
    expect(() => host.mountWebSocket({ path: '/late', hooks: {} })).toThrow(
      'started server',
    )
    await host.stop()
    expect(() =>
      host.mountWebSocket({ path: '/late', hooks: {} }),
    ).not.toThrow()
  })

  it('ignores a stale unmount after the path was remounted', () => {
    const host = createTestHost()
    const first: ServerFetchHandler = async () => new Response('first')
    const second: ServerFetchHandler = async () => new Response('second')

    const unmount = host.mountFetchHandler({ path: '/rpc', handler: first })
    unmount()
    host.mountFetchHandler({ path: '/rpc', handler: second })
    // the stale unmount must not tear down the replacement registration
    unmount()

    const route = host.routeFor('/rpc', false)
    expect(route.kind).toBe('fetch')
    expect(route.kind === 'fetch' && route.handler).toBe(second)
  })
})
