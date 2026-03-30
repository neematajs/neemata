import type { TransportWorker } from '@nmtjs/gateway'
import { createTransport, StreamTimeout } from '@nmtjs/gateway'
import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

import {
  ApplicationWorkerRuntime,
  createProcedure,
  createRootRouter,
  createRouter,
  defineApplication,
  defineServer,
} from '../src/runtime/index.ts'

type TestGatewayConfig = {
  heartbeat?: false | { interval?: number; timeout?: number }
  streamTimeouts?: Partial<Record<StreamTimeout, number>>
}

function createRuntime(gateway: TestGatewayConfig = {}) {
  const transportWorker: TransportWorker = {
    start: async () => 'test://transport',
    stop: async () => {},
  }

  const transport = createTransport({
    proxyable: undefined,
    factory: async () => transportWorker,
  })

  const router = createRootRouter([
    createRouter({
      routes: {
        ping: createProcedure({
          input: t.object({ ok: t.boolean() }),
          output: t.object({ ok: t.boolean() }),
          handler: async (_ctx, input) => input,
        }),
      },
    }),
  ] as const)

  const appConfig = defineApplication({
    router,
    transports: { test: transport },
    gateway,
  })

  const serverConfig = defineServer({
    logger: { pinoOptions: { enabled: false } },
    applications: {},
  })

  return new ApplicationWorkerRuntime(
    serverConfig,
    {
      name: 'test-app',
      path: '/virtual/test-app.ts',
      transports: { test: {} },
    },
    appConfig,
  )
}

describe('application config', () => {
  it('propagates gateway heartbeat and stream timeout overrides to the runtime gateway', async () => {
    const runtime = createRuntime({
      heartbeat: { interval: 4321, timeout: 8765 },
      streamTimeouts: {
        [StreamTimeout.Pull]: 1111,
        [StreamTimeout.Finish]: 2222,
      },
    })

    let started = false

    try {
      await runtime.start()
      started = true

      expect(runtime.gateway.options.heartbeat).toEqual({
        interval: 4321,
        timeout: 8765,
      })
      expect(runtime.gateway.options.streamTimeouts).toEqual({
        [StreamTimeout.Pull]: 1111,
        [StreamTimeout.Consume]: 15000,
        [StreamTimeout.Finish]: 2222,
      })
    } finally {
      if (started) await runtime.stop()
    }
  })

  it('propagates disabled heartbeat config without losing stream timeout defaults', async () => {
    const runtime = createRuntime({ heartbeat: false })

    let started = false

    try {
      await runtime.start()
      started = true

      expect(runtime.gateway.options.heartbeat).toBe(false)
      expect(runtime.gateway.options.streamTimeouts).toEqual({
        [StreamTimeout.Pull]: 15000,
        [StreamTimeout.Consume]: 15000,
        [StreamTimeout.Finish]: 120000,
      })
    } finally {
      if (started) await runtime.stop()
    }
  })
})
