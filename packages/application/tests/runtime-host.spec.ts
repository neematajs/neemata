import type { TransportWorker, TransportWorkerParams } from '@nmtjs/gateway'
import type { ProtocolFormats } from '@nmtjs/protocol/server'
import { createFactoryInjectable, createLogger } from '@nmtjs/core'
import { createTransport, StreamTimeout } from '@nmtjs/gateway'
import { t } from '@nmtjs/type'
import { describe, expect, it, vi } from 'vitest'

import {
  createApplicationHost,
  createGuard,
  createMeta,
  createMiddleware,
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

  it('registers each root-composed source router once in procedure paths', async () => {
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    const allowed = createMeta<'get'>()
    const procedure = createProcedure({ handler: async () => ({ ok: true }) })
    const route = createRouter({
      meta: [allowed.static('get')],
      routes: { ping: procedure },
    })
    const rootRouter = createRootRouter([route] as const)
    const runtime = new NeemataApplication(
      defineApplication({ router: rootRouter }),
      { logger },
    )

    try {
      await runtime.initialize()
      const path = runtime.procedures.get('ping')?.path

      expect(path).toHaveLength(2)
      expect(path?.[0]).toBe(rootRouter)
      expect(path?.[1]).toBe(route)
      expect(runtime.routers.has(rootRouter)).toBe(true)
      expect(runtime.routers.has(route)).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  it('tracks nested routers from root-composed sources', async () => {
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    const nested = createRouter({
      routes: {
        status: createProcedure({ handler: async () => ({ ok: true }) }),
      },
    })
    const source = createRouter({ routes: { api: nested } })
    const mountedNested = source.routes.api
    const rootRouter = createRootRouter([source] as const)
    const runtime = new NeemataApplication(
      defineApplication({ router: rootRouter }),
      { logger },
    )

    try {
      await runtime.initialize()

      expect(runtime.routers.has(rootRouter)).toBe(true)
      expect(runtime.routers.has(source)).toBe(true)
      expect(runtime.routers.has(mountedNested)).toBe(true)
      const path = runtime.procedures.get('api/status')?.path
      expect(path).toHaveLength(3)
      expect(path?.[0]).toBe(rootRouter)
      expect(path?.[1]).toBe(source)
      expect(path?.[2]).toBe(mountedNested)
    } finally {
      await runtime.dispose()
    }
  })

  it('initializes root-composed source router context dependencies', async () => {
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    const initialized = new Set<string>()
    const metaMarker = createFactoryInjectable({
      create() {
        initialized.add('meta')
        return true
      },
    })
    const guardMarker = createFactoryInjectable({
      create() {
        initialized.add('guard')
        return true
      },
    })
    const middlewareMarker = createFactoryInjectable({
      create() {
        initialized.add('middleware')
        return true
      },
    })
    const metaDependency = createFactoryInjectable({
      dependencies: { marker: metaMarker },
      create() {
        return 'get' as const
      },
    })
    const guardDependency = createFactoryInjectable({
      dependencies: { marker: guardMarker },
      create() {
        return true
      },
    })
    const middlewareDependency = createFactoryInjectable({
      dependencies: { marker: middlewareMarker },
      create() {
        return true
      },
    })
    const allowed = createMeta<'get'>()
    const source = createRouter({
      meta: [
        allowed.factory({
          dependencies: { value: metaDependency },
          handler: (ctx) => ctx.value,
        }),
      ],
      guards: [
        createGuard({
          dependencies: { allow: guardDependency },
          handler: (ctx) => ctx.allow,
        }),
      ],
      middlewares: [
        createMiddleware({
          dependencies: { active: middlewareDependency },
          handler: (_ctx, _call, next, payload) => next(payload),
        }),
      ],
      routes: {
        ping: createProcedure({ handler: async () => ({ ok: true }) }),
      },
    })
    const runtime = new NeemataApplication(
      defineApplication({ router: createRootRouter([source] as const) }),
      { logger },
    )

    try {
      await runtime.initialize()

      expect(initialized).toEqual(new Set(['meta', 'guard', 'middleware']))
    } finally {
      await runtime.dispose()
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
