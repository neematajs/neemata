import type { TransportWorker, TransportWorkerParams } from '@nmtjs/gateway'
import type { ProtocolFormats } from '@nmtjs/protocol/server'
import { createLogger } from '@nmtjs/core'
import { createTransport, StreamTimeout } from '@nmtjs/gateway'
import { t } from '@nmtjs/type'
import { describe, expect, it, vi } from 'vitest'

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

function createTestTransport<Options>(url: string) {
  const state = {
    factoryOptions: [] as Options[],
    startParams: [] as TransportWorkerParams[],
    stopParams: [] as Pick<TransportWorkerParams, 'formats'>[],
  }

  const worker: TransportWorker = {
    start: async (params) => {
      state.startParams.push(params)
      return url
    },
    stop: async (params) => {
      state.stopParams.push(params)
    },
  }

  return {
    transport: createTransport({
      proxyable: undefined,
      factory: async (options: Options) => {
        state.factoryOptions.push(options)
        return worker
      },
    }),
    state,
  }
}

function createFormats() {
  return {} as ProtocolFormats
}

describe('application runtime boundary', () => {
  it('initializes application API without transports', async () => {
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    const runtime = new NeemataApplication(createApp(), {
      logger,
      name: 'test-app',
    })

    try {
      await runtime.initialize()

      expect(runtime.logger.bindings()).toMatchObject({
        $label: 'NeemataApplication',
        application: 'test-app',
      })
      expect(runtime.procedures.has('ping')).toBe(true)
      expect(runtime.routers.size).toBeGreaterThan(0)
    } finally {
      await runtime.dispose()
    }
  })

  it('warns when root-composed routers duplicate a top-level route', async () => {
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    const warn = vi.spyOn(logger, 'warn')
    const first = createRouter({
      routes: {
        ping: createProcedure({ handler: async () => ({ ok: true }) }),
      },
    })
    const second = createRouter({
      routes: {
        ping: createProcedure({ handler: async () => ({ ok: true }) }),
      },
    })
    const runtime = new NeemataApplication(
      defineApplication({ router: createRootRouter([first, second] as const) }),
      { logger },
    )

    try {
      await expect(runtime.initialize()).rejects.toThrow(
        'Procedure ping already registered',
      )
      expect(warn).toHaveBeenCalledWith(
        { route: 'ping' },
        'Duplicate root router route',
      )
    } finally {
      await runtime.dispose()
      warn.mockRestore()
    }
  })

  it('hosts one application definition on different serving surfaces', async () => {
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    const app = createApp()
    const formats = createFormats()
    const httpOptions = { listen: { port: 3000 }, cors: true }
    const memoryOptions = { id: 'test-memory' }
    const http = createTestTransport<typeof httpOptions>(
      'http://127.0.0.1:3000',
    )
    const memory = createTestTransport<typeof memoryOptions>('memory://test')

    const httpHost = createApplicationHost(app, {
      logger,
      formats,
      transports: { http: { transport: http.transport, options: httpOptions } },
      gateway: {
        heartbeat: false,
        streamTimeouts: { [StreamTimeout.Pull]: 100 },
      },
    })
    const memoryHost = createApplicationHost(app, {
      logger,
      formats,
      transports: {
        memory: { transport: memory.transport, options: memoryOptions },
      },
    })

    try {
      await httpHost.start()
      await memoryHost.start()

      expect(http.state.factoryOptions).toEqual([httpOptions])
      expect(memory.state.factoryOptions).toEqual([memoryOptions])
      expect(http.state.startParams).toHaveLength(1)
      expect(memory.state.startParams).toHaveLength(1)
      expect(http.state.startParams[0].formats).toBe(formats)
      expect(memory.state.startParams[0].formats).toBe(formats)
      expect(httpHost.gateway.options.heartbeat).toBe(false)
      expect(httpHost.gateway.options.streamTimeouts[StreamTimeout.Pull]).toBe(
        100,
      )
    } finally {
      await memoryHost.stop()
      await httpHost.stop()
    }

    expect(http.state.stopParams).toHaveLength(1)
    expect(memory.state.stopParams).toHaveLength(1)
    expect(http.state.stopParams[0].formats).toBe(formats)
    expect(memory.state.stopParams[0].formats).toBe(formats)
  })
})
