import type { TransportWorker } from '@nmtjs/gateway'
import type { ProtocolFormats } from '@nmtjs/protocol/server'
import { createLogger } from '@nmtjs/core'
import { createTransport, StreamTimeout } from '@nmtjs/gateway'
import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

import {
  createApplicationHost,
  createProcedure,
  createRootRouter,
  createRouter,
  defineApplication,
  NeemataApplication,
} from '../src/index.ts'

function createApp() {
  return defineApplication({
    router: createRootRouter([
      createRouter({
        routes: {
          ping: createProcedure({
            input: t.object({ ok: t.boolean() }),
            output: t.object({ ok: t.boolean() }),
            handler: async (_ctx, input) => input,
          }),
        },
      }),
    ] as const),
  })
}

function createTestTransport(url: string) {
  let started = false
  let stopped = false

  const worker: TransportWorker = {
    start: async () => {
      started = true
      return url
    },
    stop: async () => {
      stopped = true
    },
  }

  return {
    transport: createTransport({
      proxyable: undefined,
      factory: async () => worker,
    }),
    state: {
      get started() {
        return started
      },
      get stopped() {
        return stopped
      },
    },
  }
}

function createFormats() {
  return {} as ProtocolFormats
}

describe('application runtime boundary', () => {
  it('initializes application API without transports', async () => {
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    const runtime = new NeemataApplication(createApp(), { logger })

    try {
      await runtime.initialize()

      expect(runtime.procedures.has('ping')).toBe(true)
      expect(runtime.routers.size).toBeGreaterThan(0)
    } finally {
      await runtime.dispose()
    }
  })

  it('hosts one application definition on different serving surfaces', async () => {
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    const app = createApp()
    const http = createTestTransport('http://127.0.0.1:3000')
    const memory = createTestTransport('memory://test')

    const httpHost = createApplicationHost(app, {
      logger,
      formats: createFormats(),
      transports: { http: { transport: http.transport, options: {} } },
      gateway: {
        heartbeat: false,
        streamTimeouts: { [StreamTimeout.Pull]: 100 },
      },
    })
    const memoryHost = createApplicationHost(app, {
      logger,
      formats: createFormats(),
      transports: { memory: { transport: memory.transport, options: {} } },
    })

    try {
      await httpHost.start()
      await memoryHost.start()

      expect(http.state.started).toBe(true)
      expect(memory.state.started).toBe(true)
      expect(httpHost.gateway.options.heartbeat).toBe(false)
      expect(httpHost.gateway.options.streamTimeouts[StreamTimeout.Pull]).toBe(
        100,
      )
    } finally {
      await memoryHost.stop()
      await httpHost.stop()
    }

    expect(http.state.stopped).toBe(true)
    expect(memory.state.stopped).toBe(true)
  })
})
