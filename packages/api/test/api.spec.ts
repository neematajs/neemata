import type { Container } from '@nmtjs/core'
import type { Connection } from '@nmtjs/protocol/server'
import { createFactoryInjectable, createValueInjectable } from '@nmtjs/core'
import { ErrorCode } from '@nmtjs/protocol'
import { ProtocolInjectables } from '@nmtjs/protocol/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApiCallOptions } from '../src/api.ts'
import type { ApiRegistry } from '../src/registry.ts'
import type { Router } from '../src/router.ts'
import type { TestApiRuntime, TestRouterContract } from './_utils.ts'
import { Api, ApiError } from '../src/api.ts'
import { createRouter } from '../src/router.ts'
import {
  testApiRuntime,
  testConnection,
  testProcedure,
  testRouter,
} from './_utils.ts'

describe.sequential('Api', () => {
  const payload = { test: 'test' }

  let runtime: TestApiRuntime
  let api: Api
  let registry: ApiRegistry
  let router: Router<typeof TestRouterContract>
  let connection: Connection
  let container: Container

  const call = (
    options: Pick<ApiCallOptions, 'procedure'> &
      Partial<Omit<ApiCallOptions, 'procedure'>>,
  ) => {
    const activeContainer = container
    return api
      .call({
        container: activeContainer,
        connection,
        payload,
        signal: new AbortController().signal,
        ...options,
        procedure: options.procedure.contract.name!,
      })
      .finally(async () => {
        await activeContainer.dispose()
      })
  }

  beforeEach(() => {
    runtime = testApiRuntime()
    api = runtime.api
    registry = runtime.registry
    container = runtime.createCallContainer()
    connection = testConnection({ data: {} })
  })

  afterEach(async () => {
    await container.dispose()
    await runtime.dispose()
  })

  it('should be an api', () => {
    expect(api).toBeDefined()
    expect(api).toBeInstanceOf(Api)
  })

  it('should inject context', async () => {
    const spy = vi.fn()
    const procedure = testProcedure({
      dependencies: { connection: ProtocolInjectables.connection },
      handler: spy,
    })
    router = testRouter({ routes: { testProcedure: procedure } })
    registry.registerRouter(router)
    await runtime.initialize()

    const connection = testConnection()
    await call({ connection, procedure })
    expect(spy).toHaveBeenCalledWith({ connection }, payload)
  })

  it('should handle procedure call', async () => {
    const procedure = testProcedure(() => 'result')
    router = testRouter({ routes: { testProcedure: procedure } })
    registry.registerRouter(router)
    await runtime.initialize()
    await expect(call({ procedure })).resolves.toMatchObject({
      output: 'result',
    })
  })

  it('should inject dependencies', async () => {
    const injectable = createValueInjectable('value')
    const procedure = testProcedure({
      dependencies: { injectable },
      handler: ({ injectable }) => injectable,
    })

    router = testRouter({ routes: { testProcedure: procedure } })
    registry.registerRouter(router)
    await runtime.initialize()
    await expect(call({ procedure })).resolves.toMatchObject({
      output: 'value',
    })
  })

  it('should inject connection', async () => {
    const injectable = createFactoryInjectable({
      dependencies: { connection: ProtocolInjectables.connection },
      factory: ({ connection }) => connection,
    })
    const procedure = testProcedure({
      dependencies: { injectable },
      handler: ({ injectable }) => injectable,
    })
    router = testRouter({ routes: { testProcedure: procedure } })
    registry.registerRouter(router)
    await runtime.initialize()
    const connection = testConnection()
    const spy = vi.spyOn(procedure, 'handler')
    await call({ connection, procedure })
    expect(spy).toReturnWith(connection)
  })

  it('should inject signal', async () => {
    const signal = new AbortController().signal
    const procedure = testProcedure({
      dependencies: { injectable: ProtocolInjectables.rpcClientAbortSignal },
      handler: ({ injectable }) => injectable,
    })
    router = testRouter({ routes: { testProcedure: procedure } })
    registry.registerRouter(router)
    await runtime.initialize()
    const connection = testConnection()
    const spy = vi.spyOn(procedure, 'handler')
    await call({ connection, procedure, signal })
    expect(spy).toReturnWith(signal)
  })

  it('should handle procedure call with payload', async () => {
    const spy = vi.fn()
    const procedure = testProcedure(spy)
    router = testRouter({ routes: { testProcedure: procedure } })
    registry.registerRouter(router)
    await runtime.initialize()
    await call({ procedure, payload })
    expect(spy).toBeCalledWith(expect.anything(), payload)
  })

  it('should handle procedure handler error', async () => {
    const procedure = testProcedure(() => {
      throw new Error()
    })
    router = testRouter({ routes: { testProcedure: procedure } })
    registry.registerRouter(router)
    await runtime.initialize()
    const result = await call({ procedure }).catch((v) => v)
    expect(result).toBeInstanceOf(Error)
  })

  it('should handle filter', async () => {
    const filterInjectable = { catch: vi.fn(() => new ApiError('custom')) }
    class CustomError extends Error {}
    const filter = createValueInjectable(filterInjectable)
    registry.registerFilter(CustomError, filter)
    const error = new CustomError()
    const procedure = testProcedure(() => {
      throw error
    })
    router = testRouter({ routes: { testProcedure: procedure } })
    registry.registerRouter(router)
    await runtime.initialize()
    await expect(call({ procedure })).rejects.toBeInstanceOf(ApiError)
    expect(filterInjectable.catch).toHaveBeenCalledOnce()
    expect(filterInjectable.catch).toHaveBeenCalledWith(error)
  })

  it('should handle guard', async () => {
    const guardLike = { can: vi.fn(() => false) }
    const guard = createValueInjectable(guardLike)
    const procedure = testProcedure({
      guards: [guard],
      handler: () => 'result',
    })

    router = testRouter({ routes: { testProcedure: procedure } })
    registry.registerRouter(router)
    await runtime.initialize()
    const result = await call({ procedure }).catch((v) => v)
    expect(result).toBeInstanceOf(ApiError)
    expect(result).toHaveProperty('code', ErrorCode.Forbidden)
  })

  it('should handle middleware', async () => {
    const middleware1Like = {
      handle: vi.fn(async (_ctx, next, payload) => {
        const result = await next({ test: `${payload.test}2` })
        return { test: `${result.test}_middleware1` }
      }),
    }
    const middleware2Like = {
      handle: vi.fn(async (_ctx, next, payload) => {
        const result = await next({ test: `${payload.test}3` })
        return { test: `${result.test}_middleware2` }
      }),
    }

    const handlerFn = vi.fn(() => ({ test: 'result' }))

    const middleware1 = createValueInjectable(middleware1Like)
    const middleware2 = createValueInjectable(middleware2Like)
    const procedure = testProcedure({
      middlewares: [middleware1, middleware2],
      handler: handlerFn,
    })
    router = testRouter({ routes: { testProcedure: procedure } })
    registry.registerRouter(router)
    await runtime.initialize()

    const response = await call({
      procedure: router.routes.testProcedure,
      payload: { test: '1' },
    })

    expect(middleware1Like.handle).toHaveBeenCalledWith(
      { connection, container, procedure, path: [router] },
      expect.any(Function),
      { test: '1' },
    )
    expect(middleware2Like.handle).toHaveBeenCalledWith(
      { connection, container, procedure, path: [router] },
      expect.any(Function),
      { test: '12' },
    )
    expect(handlerFn).toHaveBeenCalledWith(expect.anything(), { test: '123' })
    expect(response.output).toStrictEqual({
      test: 'result_middleware2_middleware1',
    })
  })

  it('should find procedure', async () => {
    const procedure = testProcedure(() => 'result')
    const router = createRouter({ routes: { testProcedure: procedure } })
    registry.registerRouter(router)
    await runtime.initialize()
    const found = api.find('testProcedure')
    expect(found).toHaveProperty('path', [router])
    expect(found).toHaveProperty('procedure', router.routes.testProcedure)
  })
})
