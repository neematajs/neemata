import type { TransportWorker, TransportWorkerParams } from '@nmtjs/gateway'
import type {
  SubscriptionAdapterEvent,
  SubscriptionAdapterType,
} from '../src/runtime/index.ts'
import type { RuntimePlugin } from '@nmtjs/application'
import { EventContract, SubscriptionContract } from '@nmtjs/contract'
import { createValueInjectable, provision } from '@nmtjs/core'
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
  publish,
  subscriptionAdapter,
} from '../src/runtime/index.ts'

type TestGatewayConfig = {
  heartbeat?: false | { interval?: number; timeout?: number }
  streamTimeouts?: Partial<Record<StreamTimeout, number>>
}

type TestTransportOptions = { marker: string; listen: { port: number } }

class TestSubscriptionAdapter implements SubscriptionAdapterType {
  published: Array<{ channel: string; payload: any }> = []

  async initialize() {}

  async dispose() {}

  async publish(channel: string, payload: any): Promise<boolean> {
    this.published.push({ channel, payload })
    return true
  }

  async *subscribe(): AsyncGenerator<SubscriptionAdapterEvent> {}
}

function createRuntime(
  options: {
    gateway?: TestGatewayConfig
    identity?: ReturnType<typeof createValueInjectable<string>>
    plugins?: RuntimePlugin[]
    publishDependency?: boolean
    serverSubscriptionAdapter?: SubscriptionAdapterType
    transportOptions?: TestTransportOptions
  } = {},
) {
  const {
    gateway = {},
    identity,
    plugins = [],
    publishDependency = false,
    serverSubscriptionAdapter,
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
          dependencies: publishDependency ? { publish } : {},
          handler: async (_ctx, input) => input,
        }),
      },
    }),
  ] as const)

  const appConfig = defineApplication({ router, plugins })
  const hostDefinition = defineApplicationHost(appConfig, {
    transports: { test: transport },
    gateway,
    identity,
  })

  const serverConfig = defineServer({
    logger: { pinoOptions: { enabled: false } },
    applications: { 'test-app': { threads: [{ test: transportOptions }] } },
    subscription: serverSubscriptionAdapter
      ? { adapter: serverSubscriptionAdapter }
      : undefined,
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
  it('propagates host gateway and identity overrides to the runtime gateway', async () => {
    const identity = createValueInjectable('test-identity')
    const { runtime } = createRuntime({
      identity,
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
      expect(runtime.gateway.options.identity).toBe(identity)
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

  it('uses subscription adapters provided by application plugin injections', async () => {
    const adapter = new TestSubscriptionAdapter()
    const plugin: RuntimePlugin = {
      name: 'test-subscription-adapter',
      injections: [provision(subscriptionAdapter, adapter)],
    }
    const subscription = SubscriptionContract.withOptions<{ roomId: string }>()(
      {
        name: 'chat',
        events: {
          message: EventContract({ payload: t.object({ text: t.string() }) }),
        },
      },
    )
    const { runtime } = createRuntime({
      plugins: [plugin],
      publishDependency: true,
    })

    let started = false

    try {
      await runtime.start()
      started = true

      const appPublish = await runtime.application.container.resolve(publish)
      await expect(
        appPublish(
          subscription.events.message,
          { roomId: 'room-1' },
          { text: 'hello' },
        ),
      ).resolves.toBe(true)
    } finally {
      if (started) await runtime.stop()
    }

    expect(adapter.published).toHaveLength(1)
  })

  it('uses server subscription adapters as parent fallback', async () => {
    const adapter = new TestSubscriptionAdapter()
    const subscription = SubscriptionContract.withOptions<{ roomId: string }>()(
      {
        name: 'chat',
        events: {
          message: EventContract({ payload: t.object({ text: t.string() }) }),
        },
      },
    )
    const { runtime } = createRuntime({
      publishDependency: true,
      serverSubscriptionAdapter: adapter,
    })

    let started = false

    try {
      await runtime.start()
      started = true

      const appPublish = await runtime.application.container.resolve(publish)
      await expect(
        appPublish(
          subscription.events.message,
          { roomId: 'room-1' },
          { text: 'hello' },
        ),
      ).resolves.toBe(true)
    } finally {
      if (started) await runtime.stop()
    }

    expect(adapter.published).toHaveLength(1)
  })

  it('fails application initialization when publish is injected without an adapter', async () => {
    const { runtime } = createRuntime({ publishDependency: true })

    await expect(runtime.start()).rejects.toThrow(
      'No instance provided for SubscriptionAdapter injectable',
    )
  })
})
