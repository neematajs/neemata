import { createTransport } from '@nmtjs/gateway'
import { describe, expect, it } from 'vitest'

import type { ServerApplicationConfig } from '../src/runtime/index.ts'
import {
  createProcedure,
  createRootRouter,
  createRouter,
  defineApplication,
  defineApplicationHost,
} from '../src/runtime/index.ts'

const app = defineApplication({
  router: createRootRouter([
    createRouter({
      routes: { ping: createProcedure({ handler: async () => 'pong' }) },
    }),
  ] as const),
})

const first = createTransport({
  proxyable: undefined,
  factory: async (_options: { listen: { port: number }; cors?: boolean }) => ({
    start: async () => 'first://transport',
    stop: async () => {},
  }),
})

const second = createTransport({
  proxyable: undefined,
  factory: async (_options: { path: string }) => ({
    start: async () => 'second://transport',
    stop: async () => {},
  }),
})

const host = defineApplicationHost(app, { transports: { first, second } })

describe('server application host types', () => {
  it('infers thread options from application host transports', () => {
    type ThreadOptions = ServerApplicationConfig<typeof host>['threads'][number]
    type Expected = {
      first: { listen: { port: number }; cors?: boolean }
      second: { path: string }
    }

    const actual: ThreadOptions = {} as Expected
    const expected: Expected = {} as ThreadOptions

    const valid: ThreadOptions = {
      first: { listen: { port: 3000 }, cors: true },
      second: { path: '/memory' },
    }

    // @ts-expect-error: every host transport must have thread options
    const missingTransport: ThreadOptions = {
      first: { listen: { port: 3000 } },
    }

    const wrongTransportOptions = {
      // @ts-expect-error: first transport options come from first factory
      first: { path: '/wrong' },
      second: { path: '/memory' },
    } satisfies ThreadOptions

    const extraTransport = {
      first: { listen: { port: 3000 } },
      second: { path: '/memory' },
      // @ts-expect-error: unknown transport keys are rejected
      third: {},
    } satisfies ThreadOptions

    expect(actual).toBeDefined()
    expect(expected).toBeDefined()
    expect(valid).toBeDefined()
    expect(missingTransport).toBeDefined()
    expect(wrongTransportOptions).toBeDefined()
    expect(extraTransport).toBeDefined()
  })
})
