import { MessageChannel } from 'node:worker_threads'

import type {
  ConnectionIdentity,
  GatewayApi,
  TransportWorkerParams,
} from '@nmtjs/gateway'
import { createFuture } from '@nmtjs/common'
import {
  Container,
  createFactoryInjectable,
  createLogger,
  createValueInjectable,
  ExecutionEnvironmentLifecycleHook,
  Hooks,
  Scope,
} from '@nmtjs/core'
import { describe, expect, it, vi } from 'vitest'

import type { ApplicationResolvedProcedure } from '../src/api/api.ts'
import type { ApplicationTransport } from '../src/config.ts'
import {
  createProcedure,
  createRootRouter,
  createRouter,
  defineApplication,
  defineApplicationHost,
} from '../src/index.ts'
import {
  createNeemataHmrAdapter,
  ReloadableGateway,
} from '../src/internal/neem-hmr.ts'
import { defineNeemataWorker } from '../src/neem/worker.ts'

describe('Neem application HMR gateway', () => {
  it('rebinds live connection scopes to the replacement application', async () => {
    const setup = createReloadableGateway(createValueInjectable('old'))
    await setup.gateway.start()
    const connection = await setup.params().onConnect({ data: { id: 1 } })
    const previousContainer = connection.container

    await setup.gateway.reload({
      ...setup.gateway.options,
      container: setup.nextContainer,
      identity: createValueInjectable('new'),
    })

    expect(connection.container).not.toBe(previousContainer)
    expect(connection.container.find(Scope.Global)).toBe(setup.nextContainer)
    expect(connection.identity).toBe('new')

    await connection[Symbol.asyncDispose]()
    await setup.gateway.stop()
    await setup.dispose()
  })

  it('keeps the replacement committed when old scope cleanup fails', async () => {
    const setup = createReloadableGateway(createValueInjectable('old'))
    await setup.gateway.start()
    const connection = await setup.params().onConnect({ data: {} })
    const previousContainer = connection.container
    const dispose = vi
      .spyOn(previousContainer, 'dispose')
      .mockRejectedValueOnce(new Error('cleanup failed'))

    await expect(
      setup.gateway.reload({
        ...setup.gateway.options,
        container: setup.nextContainer,
        identity: createValueInjectable('new'),
      }),
    ).resolves.toBeUndefined()

    expect(dispose).toHaveBeenCalledOnce()
    expect(setup.gateway.options.container).toBe(setup.nextContainer)
    expect(connection.identity).toBe('new')
    expect(connection.container.find(Scope.Global)).toBe(setup.nextContainer)

    dispose.mockRestore()
    await previousContainer.dispose()
    await connection[Symbol.asyncDispose]()
    await setup.gateway.stop()
    await setup.dispose()
  })

  it('waits for an in-flight connection and migrates it before commit', async () => {
    const identityStarted = createFuture<void>()
    const identityRelease = createFuture<void>()
    const identity = createFactoryInjectable({
      async create() {
        identityStarted.resolve()
        await identityRelease.promise
        return 'old'
      },
    })
    const setup = createReloadableGateway(identity)
    await setup.gateway.start()

    const connecting = setup.params().onConnect({ data: {} })
    await identityStarted.promise
    let reloadSettled = false
    const reload = setup.gateway
      .reload({
        ...setup.gateway.options,
        container: setup.nextContainer,
        identity: createValueInjectable('new'),
      })
      .finally(() => {
        reloadSettled = true
      })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(reloadSettled).toBe(false)

    identityRelease.resolve()
    const [connection] = await Promise.all([connecting, reload])
    expect(connection.identity).toBe('new')
    expect(connection.container.find(Scope.Global)).toBe(setup.nextContainer)

    await connection[Symbol.asyncDispose]()
    await setup.gateway.stop()
    await setup.dispose()
  })

  it('does not admit a connection while a reload is preparing', async () => {
    const reloadStarted = createFuture<void>()
    const reloadRelease = createFuture<void>()
    const nextIdentity = createFactoryInjectable({
      async create() {
        reloadStarted.resolve()
        await reloadRelease.promise
        return 'new'
      },
    })
    const setup = createReloadableGateway(createValueInjectable('old'))
    await setup.gateway.start()
    const existing = await setup.params().onConnect({ data: { id: 1 } })

    const reload = setup.gateway.reload({
      ...setup.gateway.options,
      container: setup.nextContainer,
      identity: nextIdentity,
    })
    await reloadStarted.promise
    let connectionSettled = false
    const connecting = setup.params().onConnect({ data: { id: 2 } })
    void connecting.finally(() => {
      connectionSettled = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(connectionSettled).toBe(false)

    reloadRelease.resolve()
    const [, connection] = await Promise.all([reload, connecting])
    expect(connection.identity).toBe('new')
    expect(connection.container.find(Scope.Global)).toBe(setup.nextContainer)

    await Promise.all([
      existing[Symbol.asyncDispose](),
      connection[Symbol.asyncDispose](),
    ])
    await setup.gateway.stop()
    await setup.dispose()
  })

  it('aborts and drains active calls before disposing old scopes', async () => {
    const callStarted = createFuture<void>()
    const finishCall = createFuture<void>()
    const observedAbort = createFuture<void>()
    const setup = createReloadableGateway(
      createValueInjectable('identity'),
      async ({ signal }) => {
        signal.addEventListener('abort', () => observedAbort.resolve(), {
          once: true,
        })
        callStarted.resolve()
        await finishCall.promise
      },
    )
    await setup.gateway.start()
    const connection = await setup.params().onConnect({ data: {} })
    const previousContainer = connection.container
    const rpc = setup
      .params()
      .onRpc(
        connection,
        { procedure: 'test', payload: {} },
        new AbortController().signal,
      )
    await callStarted.promise

    let reloadSettled = false
    const reload = setup.gateway
      .reload({
        ...setup.gateway.options,
        container: setup.nextContainer,
      })
      .finally(() => {
        reloadSettled = true
      })
    await observedAbort.promise
    expect(reloadSettled).toBe(false)
    expect(connection.container).toBe(previousContainer)

    finishCall.resolve()
    await Promise.all([rpc, reload])
    expect(connection.container).not.toBe(previousContainer)

    await connection[Symbol.asyncDispose]()
    await setup.gateway.stop()
    await setup.dispose()
  })
})

describe('Neem application HMR adapter', () => {
  it('replaces application generations without restarting transports', async () => {
    const events: string[] = []
    let transportParams: TransportWorkerParams | undefined
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    const transport = createEventsTransport(events, (params) => {
      transportParams = params
    })
    const createHost = (label: string) =>
      defineApplicationHost(createApplication(label, events), {
        transports: { server: transport },
      })
    const current = defineNeemataWorker(createHost('old'))
    const next = defineNeemataWorker(createHost('new'))
    const adapter = createNeemataHmrAdapter<typeof current.definition>()
    const channel = new MessageChannel()
    const runtime = await adapter.createRuntime(current, {
      mode: 'development',
      name: 'api',
      data: { server: {} },
      logger,
      definition: current.definition,
      port: channel.port1,
    })

    try {
      await runtime.start()
      const connection = await transportParams!.onConnect({ data: {} })
      const previousContainer = connection.container
      const previousDispose = vi
        .spyOn(previousContainer, 'dispose')
        .mockRejectedValueOnce(new Error('old scope cleanup failed'))

      await expect(
        adapter.apply(runtime, current, next),
      ).resolves.toStrictEqual({ accepted: true })
      expect(previousDispose).toHaveBeenCalledOnce()
      expect(connection.container).not.toBe(previousContainer)
      expect(
        events.filter((event) => event === 'transport:start'),
      ).toHaveLength(1)
      expect(events).not.toContain('new:stop')

      previousDispose.mockRestore()
      await previousContainer.dispose()
      await connection[Symbol.asyncDispose]()
    } finally {
      await runtime.stop()
      channel.port1.close()
      channel.port2.close()
    }

    expect(events).toStrictEqual([
      'old:before-initialize',
      'old:after-initialize',
      'transport:start',
      'old:start',
      'new:before-initialize',
      'new:after-initialize',
      'new:start',
      'old:effect',
      'old:stop',
      'old:before-dispose',
      'old:after-dispose',
      'transport:stop',
      'new:effect',
      'new:stop',
      'new:before-dispose',
      'new:after-dispose',
    ])
  })

  it('rejects identity and transport boundary changes', async () => {
    const events: string[] = []
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    const transport = createEventsTransport(events)
    const host = defineApplicationHost(createApplication('current', events), {
      transports: { server: transport },
    })
    const current = defineNeemataWorker(host)
    const changed = defineNeemataWorker(
      defineApplicationHost(createApplication('changed', events), {
        transports: { server: transport },
        identity: createValueInjectable('changed'),
      }),
    )
    const adapter = createNeemataHmrAdapter<typeof host>()
    const channel = new MessageChannel()
    const runtime = await adapter.createRuntime(current, {
      mode: 'development',
      name: 'api',
      data: { server: {} },
      logger,
      definition: current.definition,
      port: channel.port1,
    })

    try {
      await runtime.start()
      await expect(
        adapter.apply(runtime, current, changed),
      ).resolves.toStrictEqual({
        accepted: false,
        reason:
          'Application identity or transport changes require a full runtime reload',
      })
    } finally {
      await runtime.stop()
      channel.port1.close()
      channel.port2.close()
    }
  })
})

function createReloadableGateway(
  identity: ConnectionIdentity,
  call: GatewayApi['call'] = async () => undefined,
) {
  const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
  const container = new Container({ logger })
  const nextContainer = new Container({ logger })
  const api = {
    resolve: vi.fn(async () => ({ name: 'test', stream: false })),
    call: vi.fn(call),
  } as unknown as GatewayApi<ApplicationResolvedProcedure>
  let params: TransportWorkerParams<ApplicationResolvedProcedure> | undefined
  const gateway = new ReloadableGateway({
    logger,
    container,
    hooks: new Hooks(),
    transports: {
      test: {
        transport: {
          async start(next) {
            params = next
            return 'test://'
          },
          async stop() {},
        },
      },
    },
    api,
    identity,
  })

  return {
    gateway,
    nextContainer,
    params: () => params!,
    async dispose() {
      await Promise.all([container.dispose(), nextContainer.dispose()])
    },
  }
}

function createApplication(label: string, events: string[]) {
  return defineApplication({
    router: createRootRouter([
      createRouter({
        routes: {
          [label]: createProcedure({ handler: () => ({ label }) }),
        },
      }),
    ]),
    lifecycleHooks: {
      [ExecutionEnvironmentLifecycleHook.BeforeInitialize]: () => {
        events.push(`${label}:before-initialize`)
      },
      [ExecutionEnvironmentLifecycleHook.AfterInitialize]: () => {
        events.push(`${label}:after-initialize`)
      },
      [ExecutionEnvironmentLifecycleHook.Start]: () => {
        events.push(`${label}:start`)
        return () => events.push(`${label}:effect`)
      },
      [ExecutionEnvironmentLifecycleHook.Stop]: () => {
        events.push(`${label}:stop`)
      },
      [ExecutionEnvironmentLifecycleHook.BeforeDispose]: () => {
        events.push(`${label}:before-dispose`)
      },
      [ExecutionEnvironmentLifecycleHook.AfterDispose]: () => {
        events.push(`${label}:after-dispose`)
      },
    },
  })
}

function createEventsTransport(
  events: string[],
  captureParams?: (params: TransportWorkerParams) => void,
) {
  return {
    proxyable: undefined,
    async factory() {
      return {
        async start(params: TransportWorkerParams) {
          captureParams?.(params)
          events.push('transport:start')
          return 'test://'
        },
        async stop() {
          events.push('transport:stop')
        },
      }
    },
  } satisfies ApplicationTransport<Record<string, never>>
}
