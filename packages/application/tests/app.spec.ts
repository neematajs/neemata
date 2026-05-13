import { createLogger } from '@nmtjs/core'
import { ProxyableTransportType } from '@nmtjs/gateway'
import { describe, expect, it } from 'vitest'

import type { ApplicationTransport } from '../src/index.ts'
import { createApp, createRootRouter, defineApplication } from '../src/index.ts'

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
})
