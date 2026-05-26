import { createLogger } from '@nmtjs/core'
import { ProxyableTransportType } from '@nmtjs/gateway'
import { ConnectionType, ProtocolVersion } from '@nmtjs/protocol'
import { describe, expect, it } from 'vitest'

import type { ApplicationTransport } from '../src/index.ts'
import {
  createApp,
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
      transports: { http: httpTransport },
    })

    const app = createApp(config, {
      logger,
      mode: 'development',
      transports: { http: { listen: { hostname: '127.0.0.1', port: 3000 } } },
    })

    const upstreams = await app.start()
    await app.stop()

    expect(upstreams).toStrictEqual([
      { type: ProxyableTransportType.HTTP, url: 'http://127.0.0.1:3000' },
    ])
    expect(events).toStrictEqual(['factory:3000', 'start', 'stop'])
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

    const app = createApp(
      defineApplication({
        router: createRootRouter([route]),
        transports: { http: transport },
      }),
      { logger, mode: 'development', transports: { http: {} } },
    )

    await app.start()
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
      await app.stop()
    }
  })
})
