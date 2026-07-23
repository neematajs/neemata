import { createLogger, ExecutionEnvironmentLifecycleHook } from '@nmtjs/core'
import { ProxyableTransportType } from '@nmtjs/gateway'
import { JsonFormat } from '@nmtjs/json-format/server'
import { MsgpackFormat } from '@nmtjs/msgpack-format/server'
import { ConnectionType, ProtocolVersion } from '@nmtjs/protocol'
import { ProtocolFormats } from '@nmtjs/protocol/server'
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
      proxyable: ProxyableTransportType.HTTP,
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
    } satisfies ApplicationTransport<
      any,
      { listen: { hostname: string; port: number } }
    >

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
      formats: createFormats(),
      transports: {
        http: {
          transport: httpTransport,
          options: { listen: { hostname: '127.0.0.1', port: 3000 } },
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
      proxyable: ProxyableTransportType.HTTP,
      async factory() {
        return {
          start(next) {
            params = next
            return 'http://127.0.0.1:3000'
          },
          stop() {},
        }
      },
    } satisfies ApplicationTransport<ConnectionType.Unidirectional, {}>

    const host = createApplicationHost(
      defineApplication({ router: createRootRouter([route]) }),
      {
        logger,
        formats: createFormats(),
        transports: { http: { transport, options: {} } },
      },
    )

    await host.start()
    try {
      const connection = await params.onConnect({
        accept: '*/*',
        contentType: '*/*',
        data: {},
        protocolVersion: ProtocolVersion.v1,
        type: ConnectionType.Unidirectional,
      })
      await using disposableConnection = connection
      const resolved = await params.resolve(connection, 'ping')

      expect(resolved.name).toBe('ping')
      expect(resolved.meta.get(allowed)).toBe('get')
    } finally {
      await host.stop()
    }
  })
})

function createFormats() {
  return new ProtocolFormats([new JsonFormat(), new MsgpackFormat()])
}
