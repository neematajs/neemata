import { Container, createLogger, Scope } from '@nmtjs/core'
import { describe, expect, it } from 'vitest'

import type {
  AnyProcedure,
  AnyRouter,
  kDefaultProcedure,
  MetadataKind,
} from '../src/index.ts'
import {
  ApplicationApi,
  createMeta,
  createProcedure,
  createRootRouter,
  createRouter,
  isProcedure,
  isRouter,
} from '../src/index.ts'

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
      if (!name) throw new Error('Procedure name missing')
      procedures.set(name, { procedure: route, path: [...path, router] })
    }
  }
  return procedures
}

describe('application resolve descriptor', () => {
  it('exposes transport-safe procedure/path/static-meta view', async () => {
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    const container = new Container({ logger })
    const allowed = createMeta<'get' | 'post', MetadataKind.STATIC>()

    const procedure = createProcedure({
      stream: 250,
      meta: [allowed.static('get')],
      handler: async function* () {
        yield 'ok'
      },
    })

    const apiRouter = createRouter({
      name: 'api',
      routes: { status: procedure },
      timeout: 1000,
    })
    const rootRouter = createRootRouter([
      createRouter({ routes: { api: apiRouter } }),
    ])

    const api = new ApplicationApi({
      container,
      logger,
      timeout: undefined,
      meta: [],
      filters: new Set(),
      middlewares: new Set(),
      guards: new Set(),
      procedures: collectProcedures(rootRouter),
    })

    const connectionContainer = container.fork(Scope.Connection)

    try {
      const resolved = await api.resolve({
        connection: { id: 'connection-1' } as any,
        procedure: 'api/status',
      })

      expect(resolved.stream).toBe(true)
      expect(resolved.name).toBe('api/status')
      expect(resolved.meta.get(allowed)).toBe('get')
      expect(resolved.procedure.name).toBe('api/status')
      expect(resolved.procedure.contract.name).toBe('api/status')
      expect(resolved.procedure.stream).toBe(true)
      expect(resolved.procedure.streamTimeout).toBe(250)
      expect(resolved.path).toHaveLength(2)
      expect(resolved.path[1]?.contract).toStrictEqual(apiRouter.contract)
      expect(resolved.path[1]?.timeout).toBe(1000)

      // @ts-expect-error handler is intentionally hidden from transport descriptor
      expect(resolved.procedure.handler).toBeUndefined()
      // @ts-expect-error dependencies are intentionally hidden from transport descriptor
      expect(resolved.procedure.dependencies).toBeUndefined()
    } finally {
      await connectionContainer.dispose()
      await container.dispose()
    }
  })
})
