import type { StaticMetaBinding } from '@nmtjs/core'
import { Container, createLogger, getStaticMetaValue, Scope } from '@nmtjs/core'
import { describe, expect, it } from 'vitest'

import type {
  AnyMetaBinding,
  AnyProcedure,
  AnyRootRouter,
  AnyRouter,
  ApplicationResolvedProcedure,
} from '../src/runtime/application/index.ts'
import { n, t } from '../src/index.ts'
import {
  ApplicationApi,
  isProcedure,
  isRouter,
  kDefaultProcedure,
} from '../src/runtime/application/index.ts'

function collectProcedures(
  router: AnyRouter,
  path: AnyRouter[] = [],
  procedures = new Map<
    string | typeof kDefaultProcedure,
    { procedure: AnyProcedure; path: AnyRouter[] }
  >(),
) {
  for (const route of Object.values(router.routes)) {
    if (isRouter(route)) {
      collectProcedures(route, [...path, router], procedures)
    } else if (isProcedure(route)) {
      const name = route.contract.name

      if (!name) {
        throw new Error('Procedure name missing in meta test harness')
      }

      procedures.set(name, { procedure: route, path: [...path, router] })
    }
  }

  return procedures
}

function createApiHarness(
  rootRouter: AnyRootRouter,
  appMeta: readonly AnyMetaBinding[] = [],
) {
  const logger = createLogger({ pinoOptions: { enabled: false } }, 'meta-test')
  const container = new Container({ logger })
  const procedures = collectProcedures(rootRouter)

  if (rootRouter.default) {
    procedures.set(kDefaultProcedure, {
      procedure: rootRouter.default,
      path: [rootRouter],
    })
  }

  const api = new ApplicationApi({
    container,
    logger,
    timeout: undefined,
    meta: appMeta,
    filters: new Set(),
    middlewares: new Set(),
    guards: new Set(),
    procedures,
  })

  return {
    api,
    async call(
      procedure: string,
      payload: unknown,
      options: {
        connection?: unknown
        onResolve?: (
          procedure: ApplicationResolvedProcedure,
        ) => void | Promise<void>
      } = {},
    ) {
      const connectionContainer = container.fork(Scope.Connection)
      const callContainer = connectionContainer.fork(Scope.Call)
      const signal = new AbortController().signal
      const connection = (options.connection ?? { id: 'connection-1' }) as any

      try {
        const resolved = await api.resolve({ procedure, connection })

        await options.onResolve?.(resolved)

        return await api.call({
          procedure,
          payload,
          container: callContainer,
          signal,
          connection,
        })
      } finally {
        await callContainer.dispose()
        await connectionContainer.dispose()
      }
    },
    cleanup: async () => {
      await container.dispose()
    },
  }
}

describe('meta runtime', () => {
  it('provides static meta bindings to resolved procedures and handler dependencies', async () => {
    const appMeta = n.meta<string>()
    const routerMeta = n.meta<string>()
    const procedureMeta = n.meta<string>()

    let capturedBindings: readonly StaticMetaBinding[] = []

    const statusProcedure = n.procedure({
      output: t.object({
        app: t.string(),
        router: t.string(),
        procedure: t.string(),
      }),
      dependencies: {
        app: appMeta,
        router: routerMeta,
        procedure: procedureMeta,
      },
      meta: [procedureMeta.static('procedure-meta')],
      handler: async (ctx) => ({
        app: ctx.app,
        router: ctx.router,
        procedure: ctx.procedure,
      }),
    })

    const reportsRouter = n.router({
      name: 'reports',
      routes: { status: statusProcedure },
      meta: [routerMeta.static('router-meta')],
    })

    const rootRouter = n.rootRouter([
      n.router({ routes: { reports: reportsRouter } }),
    ] as const)

    const harness = createApiHarness(rootRouter, [appMeta.static('app-meta')])

    try {
      const result = await harness.call('reports/status', undefined, {
        onResolve: (procedure) => {
          capturedBindings = procedure.meta.entries()
        },
      })

      expect(result).toEqual({
        app: 'app-meta',
        router: 'router-meta',
        procedure: 'procedure-meta',
      })
      expect(capturedBindings).toHaveLength(3)
      expect(getStaticMetaValue(capturedBindings, appMeta)).toBe('app-meta')
      expect(getStaticMetaValue(capturedBindings, routerMeta)).toBe(
        'router-meta',
      )
      expect(getStaticMetaValue(capturedBindings, procedureMeta)).toBe(
        'procedure-meta',
      )
    } finally {
      await harness.cleanup()
    }
  })

  it('resolves beforeDecode and afterDecode meta values before guards and handlers', async () => {
    const rawInputMeta = n.meta<{
      connectionId: string
      createdAt: string
      path: string[]
      procedureName: string
    }>()

    const decodedInputMeta = n.meta<{
      connectionId: string
      createdAt: Date
      path: string[]
      procedureName: string
      slug: string
    }>()

    const phases: Array<{
      createdAtKind: 'date' | 'string'
      path: string[]
      phase: 'afterDecode' | 'beforeDecode'
    }> = []

    let guardSawDecodedPayload = false
    let guardUsedResolvedMeta = false

    const createReportProcedure = n.procedure({
      input: t.object({ createdAt: t.date(), slug: t.string() }),
      output: t.object({
        connectionId: t.string(),
        decodedCreatedAt: t.string(),
        path: t.array(t.string()),
        procedureName: t.string(),
        rawCreatedAt: t.string(),
      }),
      dependencies: { decoded: decodedInputMeta, raw: rawInputMeta },
      guards: [
        n.guard({
          dependencies: { decoded: decodedInputMeta, raw: rawInputMeta },
          can: async (ctx, call) => {
            const payload = call.payload as { createdAt: Date; slug: string }

            guardSawDecodedPayload = payload.createdAt instanceof Date
            guardUsedResolvedMeta =
              ctx.raw.createdAt === '2026-04-17' &&
              ctx.decoded.createdAt instanceof Date &&
              ctx.decoded.slug === 'alpha'

            return guardSawDecodedPayload && guardUsedResolvedMeta
          },
        }),
      ],
      meta: [
        rawInputMeta.factory({
          resolve: async (_ctx, call, payload) => {
            const input = payload as { createdAt: string }
            const path = call.path.map((route) => route.contract.name ?? 'root')

            phases.push({
              phase: 'beforeDecode',
              createdAtKind:
                typeof input.createdAt === 'string' ? 'string' : 'date',
              path,
            })

            return {
              connectionId: (call.connection as { id: string }).id,
              createdAt: input.createdAt,
              path,
              procedureName: call.procedure.contract.name ?? 'unknown',
            }
          },
        }),
        decodedInputMeta.factory({
          phase: 'afterDecode',
          resolve: async (
            _ctx,
            call,
            input: { createdAt: Date; slug: string },
          ) => {
            const path = call.path.map((route) => route.contract.name ?? 'root')

            phases.push({
              phase: 'afterDecode',
              createdAtKind:
                input.createdAt instanceof Date ? 'date' : 'string',
              path,
            })

            return {
              connectionId: (call.connection as { id: string }).id,
              createdAt: input.createdAt,
              path,
              procedureName: call.procedure.contract.name ?? 'unknown',
              slug: input.slug,
            }
          },
        }),
      ],
      handler: async (ctx) => ({
        connectionId: ctx.decoded.connectionId,
        decodedCreatedAt: ctx.decoded.createdAt.toISOString(),
        path: ctx.decoded.path,
        procedureName: ctx.decoded.procedureName,
        rawCreatedAt: ctx.raw.createdAt,
      }),
    })

    const reportsRouter = n.router({
      name: 'reports',
      routes: { create: createReportProcedure },
    })

    const rootRouter = n.rootRouter([
      n.router({ routes: { reports: reportsRouter } }),
    ] as const)

    const connection = { id: 'connection-meta' }
    const harness = createApiHarness(rootRouter)

    try {
      const result = await harness.call(
        'reports/create',
        { createdAt: '2026-04-17', slug: 'alpha' },
        { connection },
      )

      expect(result).toEqual({
        connectionId: 'connection-meta',
        decodedCreatedAt: '2026-04-17T00:00:00.000Z',
        path: ['root', 'reports'],
        procedureName: 'reports/create',
        rawCreatedAt: '2026-04-17',
      })
      expect(phases).toEqual([
        {
          phase: 'beforeDecode',
          createdAtKind: 'string',
          path: ['root', 'reports'],
        },
        {
          phase: 'afterDecode',
          createdAtKind: 'date',
          path: ['root', 'reports'],
        },
      ])
      expect(guardSawDecodedPayload).toBe(true)
      expect(guardUsedResolvedMeta).toBe(true)
    } finally {
      await harness.cleanup()
    }
  })

  it('lets middleware consume static meta, rewrite payload, and leaves factory meta for later stages', async () => {
    const policyMeta = n.meta<string>()
    const rawMeta = n.meta<{ slug: string }>()
    const decodedMeta = n.meta<{ slug: string }>()

    const observations = {
      middlewarePolicy: '',
      middlewareRaw: undefined as { slug: string } | undefined,
      rawFactorySlug: '',
      decodedFactorySlug: '',
      guardPolicy: '',
      guardRawSlug: '',
      guardDecodedSlug: '',
      guardPayloadSlug: '',
    }

    const rewriteProcedure = n.procedure({
      input: t.object({ slug: t.string() }),
      output: t.object({
        policy: t.string(),
        rawSlug: t.string(),
        decodedSlug: t.string(),
      }),
      dependencies: { policy: policyMeta, raw: rawMeta, decoded: decodedMeta },
      middlewares: [
        n.middleware({
          dependencies: { policy: policyMeta, raw: rawMeta.optional() },
          handle: async (ctx, _call, next, payload) => {
            observations.middlewarePolicy = ctx.policy
            observations.middlewareRaw = ctx.raw

            return next({
              ...(payload as { slug: string }),
              slug: `${(payload as { slug: string }).slug}-via-middleware`,
            })
          },
        }),
      ],
      guards: [
        n.guard({
          dependencies: {
            policy: policyMeta,
            raw: rawMeta,
            decoded: decodedMeta,
          },
          can: async (ctx, call) => {
            const payload = call.payload as { slug: string }

            observations.guardPolicy = ctx.policy
            observations.guardRawSlug = ctx.raw.slug
            observations.guardDecodedSlug = ctx.decoded.slug
            observations.guardPayloadSlug = payload.slug

            return true
          },
        }),
      ],
      meta: [
        rawMeta.factory({
          resolve: async (_ctx, _call, payload) => {
            const input = payload as { slug: string }

            observations.rawFactorySlug = input.slug

            return { slug: input.slug }
          },
        }),
        decodedMeta.factory({
          phase: 'afterDecode',
          resolve: async (_ctx, _call, input: { slug: string }) => {
            observations.decodedFactorySlug = input.slug

            return { slug: input.slug }
          },
        }),
      ],
      handler: async (ctx) => ({
        policy: ctx.policy,
        rawSlug: ctx.raw.slug,
        decodedSlug: ctx.decoded.slug,
      }),
    })

    const reportsRouter = n.router({
      name: 'reports',
      routes: { rewrite: rewriteProcedure },
      meta: [policyMeta.static('router-policy')],
    })

    const rootRouter = n.rootRouter([
      n.router({ routes: { reports: reportsRouter } }),
    ] as const)

    const harness = createApiHarness(rootRouter)

    try {
      const result = await harness.call('reports/rewrite', { slug: 'alpha' })

      expect(result).toEqual({
        policy: 'router-policy',
        rawSlug: 'alpha-via-middleware',
        decodedSlug: 'alpha-via-middleware',
      })
      expect(observations).toEqual({
        middlewarePolicy: 'router-policy',
        middlewareRaw: undefined,
        rawFactorySlug: 'alpha-via-middleware',
        decodedFactorySlug: 'alpha-via-middleware',
        guardPolicy: 'router-policy',
        guardRawSlug: 'alpha-via-middleware',
        guardDecodedSlug: 'alpha-via-middleware',
        guardPayloadSlug: 'alpha-via-middleware',
      })
    } finally {
      await harness.cleanup()
    }
  })

  it('uses the narrowest static meta binding across app, router, and procedure in middleware, guards, handlers, and resolve hook', async () => {
    const policyMeta = n.meta<string>()

    let resolvePolicy: string | undefined
    let resolveBindingsCount = 0
    let middlewarePolicy: string | undefined
    let guardPolicy: string | undefined

    const statusProcedure = n.procedure({
      output: t.object({ policy: t.string() }),
      dependencies: { policy: policyMeta },
      middlewares: [
        n.middleware({
          dependencies: { policy: policyMeta },
          handle: async (ctx, _call, next, payload) => {
            middlewarePolicy = ctx.policy
            return next(payload)
          },
        }),
      ],
      guards: [
        n.guard({
          dependencies: { policy: policyMeta },
          can: async (ctx) => {
            guardPolicy = ctx.policy
            return true
          },
        }),
      ],
      meta: [policyMeta.static('procedure-policy')],
      handler: async (ctx) => ({ policy: ctx.policy }),
    })

    const reportsRouter = n.router({
      name: 'reports',
      routes: { status: statusProcedure },
      meta: [policyMeta.static('router-policy')],
    })

    const rootRouter = n.rootRouter([
      n.router({ routes: { reports: reportsRouter } }),
    ] as const)

    const harness = createApiHarness(rootRouter, [
      policyMeta.static('app-policy'),
    ])

    try {
      const result = await harness.call('reports/status', undefined, {
        onResolve: (procedure) => {
          const meta = procedure.meta.entries()

          resolveBindingsCount = meta.length
          resolvePolicy = getStaticMetaValue(meta, policyMeta)
        },
      })

      expect(result).toEqual({ policy: 'procedure-policy' })
      expect(resolveBindingsCount).toBe(3)
      expect(resolvePolicy).toBe('procedure-policy')
      expect(middlewarePolicy).toBe('procedure-policy')
      expect(guardPolicy).toBe('procedure-policy')
    } finally {
      await harness.cleanup()
    }
  })

  it('serializes procedure outputs by default and can skip serialization with runtime config', async () => {
    const outputDate = new Date('2026-04-25T12:34:56.000Z')

    const serializedProcedure = n.procedure({
      output: t.date(),
      handler: () => outputDate,
    })

    const rawProcedure = n.procedure({
      output: t.date(),
      meta: [n.config.static({ serializeOutput: false })],
      handler: () => outputDate,
    })

    const rootRouter = n.rootRouter([
      n.router({
        routes: { serialized: serializedProcedure, raw: rawProcedure },
      }),
    ] as const)

    const harness = createApiHarness(rootRouter)

    try {
      await expect(harness.call('serialized', undefined)).resolves.toBe(
        outputDate.toISOString(),
      )
      await expect(harness.call('raw', undefined)).resolves.toBe(outputDate)
    } finally {
      await harness.cleanup()
    }
  })

  it('uses the narrowest runtime config binding for output serialization', async () => {
    const outputDate = new Date('2026-04-25T12:34:56.000Z')

    const appConfiguredProcedure = n.procedure({
      output: t.date(),
      handler: () => outputDate,
    })

    const routerConfiguredProcedure = n.procedure({
      output: t.date(),
      handler: () => outputDate,
    })

    const procedureConfiguredProcedure = n.procedure({
      output: t.date(),
      meta: [n.config.static({ serializeOutput: false })],
      handler: () => outputDate,
    })

    const configuredRouter = n.router({
      name: 'configured',
      routes: {
        routerConfigured: routerConfiguredProcedure,
        procedureConfigured: procedureConfiguredProcedure,
      },
      meta: [n.config.static({ serializeOutput: true })],
    })

    const rootRouter = n.rootRouter([
      n.router({
        routes: {
          appConfigured: appConfiguredProcedure,
          configured: configuredRouter,
        },
      }),
    ] as const)

    const harness = createApiHarness(rootRouter, [
      n.config.static({ serializeOutput: false }),
    ])

    try {
      await expect(harness.call('appConfigured', undefined)).resolves.toBe(
        outputDate,
      )
      await expect(
        harness.call('configured/routerConfigured', undefined),
      ).resolves.toBe(outputDate.toISOString())
      await expect(
        harness.call('configured/procedureConfigured', undefined),
      ).resolves.toBe(outputDate)
    } finally {
      await harness.cleanup()
    }
  })

  it('applies runtime output serialization config to stream procedure chunks', async () => {
    const outputDate = new Date('2026-04-25T12:34:56.000Z')

    const serializedStreamProcedure = n.procedure({
      output: t.date(),
      stream: true,
      async *handler() {
        yield outputDate
      },
    })

    const rawStreamProcedure = n.procedure({
      output: t.date(),
      stream: true,
      meta: [n.config.static({ serializeOutput: false })],
      async *handler() {
        yield outputDate
      },
    })

    const rootRouter = n.rootRouter([
      n.router({
        routes: {
          serializedStream: serializedStreamProcedure,
          rawStream: rawStreamProcedure,
        },
      }),
    ] as const)

    const harness = createApiHarness(rootRouter)

    try {
      const serializedStream = (await harness.call(
        'serializedStream',
        undefined,
      )) as () => AsyncIterable<unknown>
      const rawStream = (await harness.call(
        'rawStream',
        undefined,
      )) as () => AsyncIterable<unknown>

      await expect(Array.fromAsync(serializedStream())).resolves.toEqual([
        outputDate.toISOString(),
      ])
      await expect(Array.fromAsync(rawStream())).resolves.toEqual([outputDate])
    } finally {
      await harness.cleanup()
    }
  })
})
