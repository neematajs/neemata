import type { TransportWorker, TransportWorkerParams } from '@nmtjs/gateway'
import { createTransport, StreamTimeout } from '@nmtjs/gateway'
import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

import {
  ApplicationWorkerRuntime,
  createProcedure,
  createRootRouter,
  createRouter,
  defineApplication,
  defineApplicationHost,
  defineServer,
} from '../src/runtime/index.ts'

type TestGatewayConfig = {
  heartbeat?: false | { interval?: number; timeout?: number }
  streamTimeouts?: Partial<Record<StreamTimeout, number>>
}

type TestTransportOptions = { marker: string; listen: { port: number } }

function createRuntime(
  options: {
    gateway?: TestGatewayConfig
    transportOptions?: TestTransportOptions
  } = {},
) {
  const {
    gateway = {},
    transportOptions = { marker: 'default', listen: { port: 0 } },
  } = options

  const transportState = {
    factoryOptions: [] as TestTransportOptions[],
    startParams: [] as TransportWorkerParams[],
    stopParams: [] as Pick<TransportWorkerParams, 'formats'>[],
  }

  const transportWorker: TransportWorker = {
    start: async (params) => {
      transportState.startParams.push(params)
      return 'test://transport'
    },
    stop: async (params) => {
      transportState.stopParams.push(params)
    },
  }

  const transport = createTransport({
    proxyable: undefined,
    factory: async (options: TestTransportOptions) => {
      transportState.factoryOptions.push(options)
      return transportWorker
    },
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

  const appConfig = defineApplication({ router })
  const hostDefinition = defineApplicationHost(appConfig, {
    transports: { test: transport },
  })

  const serverConfig = defineServer({
    logger: { pinoOptions: { enabled: false } },
    applications: {
      'test-app': { threads: [{ test: transportOptions }], gateway },
    },
  })

  return {
    runtime: new ApplicationWorkerRuntime(
      serverConfig,
      {
        name: 'test-app',
        path: '/virtual/test-app.ts',
        transports: { test: transportOptions },
      },
      hostDefinition,
    ),
    transportOptions,
    transportState,
  }
}

describe('application config', () => {
  it('propagates gateway heartbeat and stream timeout overrides to the runtime gateway', async () => {
    const { runtime } = createRuntime({
      gateway: {
        heartbeat: { interval: 4321, timeout: 8765 },
        streamTimeouts: {
          [StreamTimeout.Pull]: 1111,
          [StreamTimeout.Finish]: 2222,
        },
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
    const { runtime } = createRuntime({ gateway: { heartbeat: false } })

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

  it('passes server-owned thread transport options to host transport factories', async () => {
    const { runtime, transportOptions, transportState } = createRuntime({
      transportOptions: {
        marker: 'from-server-thread',
        listen: { port: 3210 },
      },
    })

    let started = false

    try {
      await runtime.start()
      started = true

      expect(transportState.factoryOptions).toEqual([transportOptions])
      expect(transportState.startParams).toHaveLength(1)
    } finally {
      if (started) await runtime.stop()
    }

    expect(transportState.stopParams).toHaveLength(1)
  })
})
