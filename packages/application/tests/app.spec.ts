import {
  createLogger,
  createValueInjectable,
  ExecutionEnvironmentLifecycleHook,
} from '@nmtjs/core'
import { ProxyableTransportType } from '@nmtjs/gateway'
import { describe, expect, it } from 'vitest'

import type { ApplicationTransport } from '../src/index.ts'
import {
  createApplicationHost,
  createMeta,
  createProcedure,
  createRootRouter,
  createRouter,
  defineApplication,
} from '../src/index.ts'

describe('Neemata application runtime', () => {
  it('starts and stops without Neem runtime', async () => {
    const events: string[] = []
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')

    const httpTransport = {
      proxyable: [ProxyableTransportType.HTTP],
      async factory(options: { listen: { hostname: string; port: number } }) {
        events.push(`factory:${options.listen.port}`)
        return {
          async start() {
            events.push('start')
            return `http://${options.listen.hostname}:${options.listen.port}`
          },
          async stop() {
            events.push('stop')
          },
        }
      },
    } satisfies ApplicationTransport<{
      listen: { hostname: string; port: number }
    }>

    const config = defineApplication({
      router: createRootRouter([]),
      lifecycleHooks: {
        [ExecutionEnvironmentLifecycleHook.BeforeInitialize]: () => {
          events.push('before-initialize')
        },
        [ExecutionEnvironmentLifecycleHook.AfterInitialize]: () => {
          events.push('after-initialize')
        },
        [ExecutionEnvironmentLifecycleHook.Start]: () => {
          events.push('start-hook')
        },
        [ExecutionEnvironmentLifecycleHook.Stop]: () => {
          events.push('stop-hook')
        },
        [ExecutionEnvironmentLifecycleHook.BeforeDispose]: () => {
          events.push('before-dispose')
        },
        [ExecutionEnvironmentLifecycleHook.AfterDispose]: () => {
          events.push('after-dispose')
        },
      },
    })

    const host = createApplicationHost(config, {
      logger,
      transports: {
        http: {
          transport: httpTransport,
          options: createValueInjectable({
            listen: { hostname: '127.0.0.1', port: 3000 },
          }),
        },
      },
    })

    const upstreams = await host.start()
    await host.stop()

    expect(upstreams).toStrictEqual([
      { type: ProxyableTransportType.HTTP, url: 'http://127.0.0.1:3000' },
    ])
    expect(events).toStrictEqual([
      'before-initialize',
      'after-initialize',
      'factory:3000',
      'start',
      'start-hook',
      'stop',
      'stop-hook',
      'before-dispose',
      'after-dispose',
    ])
  })

  it('runs effect teardowns before classic Stop hooks on stop', async () => {
    const events: string[] = []
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    const host = createApplicationHost(
      defineApplication({
        router: createRootRouter([]),
        lifecycleHooks: {
          [ExecutionEnvironmentLifecycleHook.Start]: () => {
            events.push('hook:start')
            return () => {
              events.push('effect:hook')
            }
          },
          [ExecutionEnvironmentLifecycleHook.Stop]: () => {
            events.push('hook:stop')
          },
        },
        plugins: [
          {
            name: 'effectful',
            hooks: {
              [ExecutionEnvironmentLifecycleHook.Start]: () => {
                events.push('plugin:start')
                return () => {
                  events.push('effect:plugin')
                }
              },
              [ExecutionEnvironmentLifecycleHook.Stop]: () => {
                events.push('plugin:stop')
              },
            },
          },
        ],
      }),
      {
        logger,
        transports: {
          server: {
            transport: createEventsTransport(events),
            options: createValueInjectable({}),
          },
        },
      },
    )

    await host.start()
    await host.stop()

    // effect teardowns unwind LIFO after the transport drains, before the
    // classic Stop hook list fires in registration order
    expect(events).toStrictEqual([
      'transport:start',
      'hook:start',
      'plugin:start',
      'transport:stop',
      'effect:plugin',
      'effect:hook',
      'hook:stop',
      'plugin:stop',
    ])
  })

  it('stops transports and disposes the application when a start hook fails', async () => {
    const events: string[] = []
    const failure = new Error('start hook failed')
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    const host = createApplicationHost(
      defineApplication({
        router: createRootRouter([]),
        lifecycleHooks: {
          [ExecutionEnvironmentLifecycleHook.Start]: () => {
            events.push('hook:start')
            return () => {
              events.push('effect:hook')
            }
          },
          [ExecutionEnvironmentLifecycleHook.Stop]: () => {
            events.push('hook:stop')
          },
          [ExecutionEnvironmentLifecycleHook.BeforeDispose]: () => {
            events.push('application:dispose')
          },
        },
        plugins: [
          {
            name: 'failing-start',
            hooks: {
              [ExecutionEnvironmentLifecycleHook.Start]: () => {
                events.push('plugin:start')
                throw failure
              },
              [ExecutionEnvironmentLifecycleHook.Stop]: () => {
                events.push('plugin:stop')
              },
            },
          },
          {
            name: 'never-started',
            hooks: {
              [ExecutionEnvironmentLifecycleHook.Start]: () => {
                events.push('unreached:start')
                return () => {
                  events.push('effect:unreached')
                }
              },
              [ExecutionEnvironmentLifecycleHook.Stop]: () => {
                events.push('unreached:stop')
              },
            },
          },
        ],
      }),
      {
        logger,
        transports: {
          server: {
            transport: createEventsTransport(events),
            options: createValueInjectable({}),
          },
        },
      },
    )

    // rollback is clean, so the original error surfaces bare
    await expect(host.start()).rejects.toBe(failure)
    // only the completed Start hook contributed an effect teardown; classic
    // Stop hooks all fire regardless, and the application disposes last
    expect(events).toStrictEqual([
      'transport:start',
      'hook:start',
      'plugin:start',
      'transport:stop',
      'effect:hook',
      'hook:stop',
      'plugin:stop',
      'unreached:stop',
      'application:dispose',
    ])
  })

  it('rejects a second start and no-ops stop before start', async () => {
    const events: string[] = []
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    const host = createApplicationHost(
      defineApplication({ router: createRootRouter([]) }),
      {
        logger,
        transports: {
          server: {
            transport: createEventsTransport(events),
            options: createValueInjectable({}),
          },
        },
      },
    )

    // stop() on a never-started host is a no-op
    await host.stop()
    expect(events).toStrictEqual([])

    await host.start()
    await expect(host.start()).rejects.toThrow(
      'The application host is already started',
    )

    await host.stop()
    expect(events).toStrictEqual(['transport:start', 'transport:stop'])
  })

  it('preserves root-composed router metadata without changing procedure names', async () => {
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    const allowed = createMeta<'get'>()
    let params: any
    const procedure = createProcedure({ handler: () => ({ ok: true }) })
    const route = createRouter({
      meta: [allowed.static('get')],
      routes: { ping: procedure },
    })
    const transport = {
      proxyable: [ProxyableTransportType.HTTP],
      async factory() {
        return {
          start(next) {
            params = next
            return 'http://127.0.0.1:3000'
          },
          stop() {},
        }
      },
    } satisfies ApplicationTransport<{}>

    const host = createApplicationHost(
      defineApplication({ router: createRootRouter([route]) }),
      {
        logger,
        transports: { http: { transport, options: createValueInjectable({}) } },
      },
    )

    await host.start()
    try {
      const connection = await params.onConnect({ data: {} })
      await using disposableConnection = connection
      const resolved = await params.resolve(connection, 'ping')

      expect(resolved.name).toBe('ping')
      expect(resolved.meta.get(allowed)).toBe('get')
    } finally {
      await host.stop()
    }
  })
})

function createEventsTransport(events: string[]) {
  return {
    proxyable: undefined,
    async factory() {
      return {
        async start() {
          events.push('transport:start')
          return 'test://'
        },
        async stop() {
          events.push('transport:stop')
        },
      }
    },
  } satisfies ApplicationTransport
}
