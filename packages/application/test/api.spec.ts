import { ErrorCode } from '@nmtjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Api, type ApiCallOptions, ApiError } from '../lib/api.ts'
import type { Application } from '../lib/application.ts'
import { injectables } from '../lib/common.ts'
import type { Connection } from '../lib/connection.ts'
import { Scope } from '../lib/constants.ts'
import {
  type Container,
  createFactoryInjectable,
  createValueInjectable,
} from '../lib/container.ts'
import type { Registry } from '../lib/registry.ts'
import type { Service } from '../lib/service.ts'
import {
  type TestServiceContract,
  testApp,
  testConnection,
  testProcedure,
  testService,
} from './_utils.ts'

describe.sequential('Api', () => {
  const transport = 'test'

  let app: Application
  let service: Service<typeof TestServiceContract>
  let registry: Registry
  let container: Container
  let connection: Connection
  let api: Api
  const connectionData = {}

  const payload = { test: 'test' }
  const call = (
    options: Pick<ApiCallOptions, 'procedure'> &
      Partial<Omit<ApiCallOptions, 'procedure'>>,
  ) =>
    api
      .call({
        service,
        container,
        transport,
        connection,
        payload,
        signal: new AbortController().signal,
        connectionData,
        ...options,
      })
      .finally(() => container.dispose())

  beforeEach(async () => {
    app = testApp()

    registry = app.registry
    container = app.container.createScope(Scope.Call)
    api = app.api

    connection = testConnection(registry, {})
  })

  afterEach(async () => {
    await app.terminate()
  })

  it('should be an api', () => {
    expect(api).toBeDefined()
    expect(api).toBeInstanceOf(Api)
  })

  it('should inject context', async () => {
    const spy = vi.fn()
    const procedure = testProcedure({
      dependencies: { connection: injectables.connection },
      handler: spy,
    })
    service = testService({ procedure })
    registry.registerService(service)
    await app.initialize()

    const connection = testConnection(registry, {})
    await call({ connection, procedure })
    expect(spy).toHaveBeenCalledWith({ connection }, payload)
  })

  it('should handle procedure call', async () => {
    const procedure = testProcedure(() => 'result')
    service = testService({ procedure })
    registry.registerService(service)
    await app.initialize()
    await expect(call({ procedure })).resolves.toBe('result')
  })

  it('should inject dependencies', async () => {
    const injectable = createValueInjectable('value')
    const procedure = testProcedure({
      dependencies: { injectable },
      handler: ({ injectable }) => injectable,
    })
    service = testService({ procedure })
    registry.registerService(service)
    await app.initialize()
    await expect(call({ procedure })).resolves.toBe('value')
  })

  it('should inject connection', async () => {
    const injectable = createFactoryInjectable({
      dependencies: { connection: injectables.connection },
      factory: ({ connection }) => connection,
    })
    const procedure = testProcedure({
      dependencies: { injectable },
      handler: ({ injectable }) => injectable,
    })
    service = testService({ procedure })
    registry.registerService(service)
    await app.initialize()
    const connection = testConnection(registry, {})
    await expect(call({ connection, procedure })).resolves.toBe(connection)
  })

  it('should inject signal', async () => {
    const signal = new AbortController().signal
    const injectable = createFactoryInjectable({
      dependencies: { signal: injectables.callSignal },
      factory: ({ signal }) => signal,
    })
    const procedure = testProcedure({
      dependencies: { injectable },
      handler: ({ injectable }) => injectable,
    })
    service = testService({ procedure })
    registry.registerService(service)
    await app.initialize()
    const connection = testConnection(registry, {})
    expect(call({ connection, procedure, signal })).resolves.toBe(signal)
  })

  it('should handle procedure call with payload', async () => {
    const spy = vi.fn()
    const procedure = testProcedure(spy)
    service = testService({ procedure })
    registry.registerService(service)
    await app.initialize()
    await call({ procedure, payload })
    expect(spy).toBeCalledWith(expect.anything(), payload)
  })

  it('should handle procedure handler error', async () => {
    const procedure = testProcedure(() => {
      throw new Error()
    })
    service = testService({ procedure })
    registry.registerService(service)
    await app.initialize()
    const result = await call({ procedure }).catch((v) => v)
    expect(result).toBeInstanceOf(Error)
  })

  it('should handle filter', async () => {
    const filterInjectable = {
      catch: vi.fn(() => new ApiError('custom')),
    }
    class CustomError extends Error {}
    const filter = createValueInjectable(filterInjectable)
    registry.registerFilter(CustomError, filter)
    const error = new CustomError()
    const procedure = testProcedure(() => {
      throw error
    })
    service = testService({ procedure })
    registry.registerService(service)
    await app.initialize()
    await expect(call({ procedure })).rejects.toBeInstanceOf(ApiError)
    expect(filterInjectable.catch).toHaveBeenCalledOnce()
    expect(filterInjectable.catch).toHaveBeenCalledWith(error)
  })

  it('should handle guard', async () => {
    const guardLike = {
      can: vi.fn(() => false),
    }
    const guard = createValueInjectable(guardLike)
    const procedure = testProcedure({
      guards: [guard],
      handler: () => 'result',
    })
    service = testService({ procedure })
    registry.registerService(service)
    await app.initialize()
    const result = await call({ procedure }).catch((v) => v)
    expect(result).toBeInstanceOf(ApiError)
    expect(result).toHaveProperty('code', ErrorCode.Forbidden)
  })

  it('should handle middleware', async () => {
    const middleware1Like = {
      handle: vi.fn(async (ctx, next, payload) => {
        const result = await next({ test: `${payload.test}2` })
        return { test: `${result.test}_middleware1` }
      }),
    }
    const middleware2Like = {
      handle: vi.fn(async (ctx, next, payload) => {
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

    service = testService({ procedure })
    registry.registerService(service)
    await app.initialize()

    const response = await call({ procedure, payload: { test: '1' } })

    expect(middleware1Like.handle).toHaveBeenCalledWith(
      {
        connection,
        container,
        procedure,
        service,
      },
      expect.any(Function),
      { test: '1' },
    )
    expect(middleware2Like.handle).toHaveBeenCalledWith(
      {
        connection,
        container,
        procedure,
        service,
      },
      expect.any(Function),
      { test: '12' },
    )
    expect(handlerFn).toHaveBeenCalledWith(expect.anything(), {
      test: '123',
    })
    expect(response).toStrictEqual({ test: 'result_middleware2_middleware1' })
  })

  it('should find procedure', async () => {
    const procedure = testProcedure(() => 'result')
    service = testService({ procedure })
    registry.registerService(service)
    await app.initialize()
    const found = api.find(service.contract.name, 'testProcedure', transport)
    expect(found).toHaveProperty('service', service)
    expect(found).toHaveProperty('procedure', procedure)
  })
})
