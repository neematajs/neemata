import { ErrorCode } from '@nmtjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Api,
  type ApiCallOptions,
  ApiError,
  Middleware,
  Procedure,
} from '../lib/api.ts'
import type { Application } from '../lib/application.ts'
import type { Connection } from '../lib/connection.ts'
import { type Container, Provider } from '../lib/container.ts'
import { providers } from '../lib/providers.ts'
import type { Registry } from '../lib/registry.ts'
import type { Service } from '../lib/service.ts'
import type { AnyProcedure, FilterFn, GuardFn } from '../lib/types.ts'
import {
  type TestServiceContract,
  testApp,
  testConnection,
  testProcedure,
  testService,
} from './_utils.ts'

describe.sequential('Procedure', () => {
  let procedure: AnyProcedure

  beforeEach(() => {
    procedure = testProcedure()
  })

  it('should be a procedure', () => {
    expect(procedure).toBeDefined()
    expect(procedure).toBeInstanceOf(Procedure)
  })

  it('should extend with dependencies', () => {
    const dep1 = new Provider().withValue('dep1')
    const dep2 = new Provider().withValue('dep2')

    const procedure1 = procedure.withDependencies({ dep1 })
    const procedure2 = procedure.withDependencies({ dep2 })

    expect(procedure).toBe(procedure1)
    expect(procedure1).toBe(procedure2)
    expect(procedure.dependencies).toHaveProperty('dep1', dep1)
    expect(procedure.dependencies).toHaveProperty('dep2', dep2)
  })

  // it('should extend with guards', () => {
  //   const guard1 = new Provider().withValue((() => false) as GuardFn)
  //   const guard2 = new Provider().withValue((() => true) as GuardFn)

  //   const newProcedure = procedure.withGuards(guard1)
  //   const newProcedure2 = newProcedure.withGuards(guard2)

  //   expect(newProcedure2.guards).toEqual([guard1, guard2])
  //   expect(newProcedure2).not.toBe(procedure)
  // })

  // it('should extend with middlewares', () => {
  //   const middleware1 = new Provider().withValue((() => void 0) as MiddlewareFn)
  //   const middleware2 = new Provider().withValue((() => void 0) as MiddlewareFn)

  //   const newProcedure = procedure.withMiddlewares(middleware1)
  //   const newProcedure2 = newProcedure.withMiddlewares(middleware2)

  //   expect(newProcedure2.middlewares).toEqual([middleware1, middleware2])
  //   expect(newProcedure2).not.toBe(procedure)
  // })

  // it('should extend with a handler', () => {
  //   const handler = () => {}
  //   const newProcedure = procedure.withHandler(handler)
  //   expect(newProcedure.handler).toBe(handler)
  //   expect(newProcedure).not.toBe(procedure)
  // })

  // it('should extend with a input', () => {
  //   const input = {}
  //   const newProcedure = procedure.withInput(input)
  //   expect(newProcedure.input).toBe(input)
  //   expect(newProcedure).not.toBe(procedure)
  // })

  // it('should extend with a output', () => {
  //   const output = {}
  //   const newProcedure = procedure.withOutput(output)
  //   expect(newProcedure.output).toBe(output)
  //   expect(newProcedure).not.toBe(procedure)
  // })

  // it('should extend with an input parser', () => {
  //   const parser = new TestParser()
  //   const newProcedure = procedure.withInputParser(parser)
  //   expect(newProcedure.parsers?.input).toBe(parser)
  //   expect(newProcedure).not.toBe(procedure)
  // })

  // it('should extend with an output parser', () => {
  //   const parser = new TestParser()
  //   const newProcedure = procedure.withOutputParser(parser)
  //   expect(newProcedure.parsers?.output).toBe(parser)
  //   expect(newProcedure).not.toBe(procedure)
  // })

  // it('should extend with parser', () => {
  //   const inputParser = new TestParser()
  //   const parser = new TestParser()
  //   const newProcedure = procedure
  //     .withInputParser(inputParser)
  //     .withParser(parser)
  //   expect(newProcedure.parsers?.input).not.toBe(inputParser)
  //   expect(newProcedure.parsers?.output).toBe(parser)
  // })

  // it('should extend with a timeout', () => {
  //   const newProcedure = procedure.withTimeout(1000)
  //   expect(newProcedure.timeout).toEqual(1000)
  //   expect(newProcedure).not.toBe(procedure)
  // })

  // it('should fail clone with a timeout', () => {
  //   expect(() => procedure.withTimeout(-1000)).toThrow()
  // })

  // it('should extend with a transports', () => {
  //   const newProcedure = procedure.withTransport(TestTransport)
  //   expect(newProcedure.transports.has(TestTransport)).toEqual(true)
  //   expect(newProcedure).not.toBe(procedure)
  // })
})

describe.sequential('Api', () => {
  const transport = 'test'

  let app: Application
  let service: Service<typeof TestServiceContract>
  let registry: Registry
  let container: Container
  let connection: Connection
  let api: Api

  const payload = { test: 'test' }
  const call = (
    options: Pick<ApiCallOptions, 'procedure'> &
      Partial<Omit<ApiCallOptions, 'procedure'>>,
  ) =>
    api.call({
      service,
      container,
      transport,
      connection,
      payload,
      signal: new AbortController().signal,
      ...options,
    })

  const testProcedure = () =>
    new Procedure(service.contract.procedures.testProcedure)

  beforeEach(async () => {
    app = testApp()

    registry = app.registry
    container = app.container
    api = app.api

    connection = testConnection(registry, {})
    service = testService()
    registry.registerService(service)

    await app.initialize()
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
    const procedure = testProcedure()
      .withDependencies({ connection: providers.connection })
      .withHandler(spy)
    service.implement('testProcedure', procedure)
    const connection = testConnection(registry, {})
    await call({ connection, procedure })
    expect(spy).toHaveBeenCalledWith({ connection }, payload)
  })

  it('should handle procedure call', async () => {
    const procedure = testProcedure().withHandler(() => 'result')
    service.implement('testProcedure', procedure)
    await expect(call({ procedure })).resolves.toBe('result')
  })

  it('should inject dependencies', async () => {
    const provider = new Provider().withValue('value')
    const procedure = testProcedure()
      .withDependencies({ provider })
      .withHandler(({ provider }) => provider)
    service.implement('testProcedure', procedure)
    await expect(call({ procedure })).resolves.toBe('value')
  })

  it('should inject connection', async () => {
    const provider = new Provider()
      .withDependencies({ connection: providers.connection })
      .withFactory(({ connection }) => connection)
    const procedure = testProcedure()
      .withDependencies({ provider })
      .withHandler(({ provider }) => provider)
    service.implement('testProcedure', procedure)
    const connection = testConnection(registry, {})
    await expect(call({ connection, procedure })).resolves.toBe(connection)
  })

  it('should inject signal', async () => {
    const signal = new AbortController().signal
    const provider = new Provider()
      .withDependencies({ signal: providers.callSignal })
      .withFactory(({ signal }) => signal)
    const procedure = testProcedure()
      .withDependencies({ provider })
      .withHandler(({ provider }) => provider)
    service.implement('testProcedure', procedure)
    const connection = testConnection(registry, {})
    expect(call({ connection, procedure, signal })).resolves.toBe(signal)
  })

  // it('should inject encoded stream response', async () => {
  //   const handlerFn = vi.fn(({ response }) => response)
  //   const procedure = new Procedure(
  //     service.contract.procedures.testEncodedStream,
  //   )
  //     .withDependencies({ response: Procedure.response })
  //     .withHandler(handlerFn)
  //   service.implement('testEncodedStream', procedure)
  //   await call({ procedure, payload }).catch((v) => v)
  //   expect(handlerFn).toBeCalledWith(
  //     {
  //       response: expect.any(EncodedStreamResponse),
  //     },
  //     expect.anything(),
  //   )
  // })

  it('should handle procedure call with payload', async () => {
    const spy = vi.fn()
    const procedure = testProcedure().withHandler(spy)
    service.implement('testProcedure', procedure)
    await call({ procedure, payload })
    expect(spy).toBeCalledWith(expect.anything(), payload)
  })

  it('should handle procedure handler error', async () => {
    const procedure = testProcedure().withHandler(() => {
      throw new Error()
    })
    service.implement('testProcedure', procedure)
    const result = await call({ procedure }).catch((v) => v)
    expect(result).toBeInstanceOf(Error)
  })

  it('should handle filter', async () => {
    const spy = vi.fn(() => new ApiError('custom'))
    class CustomError extends Error {}
    const filter = new Provider().withValue(spy as FilterFn)
    registry.registerFilter(CustomError, filter)
    const error = new CustomError()
    const procedure = testProcedure().withHandler(() => {
      throw error
    })
    service.implement('testProcedure', procedure)
    await expect(call({ procedure })).rejects.toBeInstanceOf(ApiError)
    expect(spy).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledWith(error)
  })

  it('should handle guard', async () => {
    const guard = new Provider().withValue((() => false) as GuardFn)
    const procedure = testProcedure()
      .withGuards(guard)
      .withHandler(() => 'result')
    service.implement('testProcedure', procedure)
    const result = await call({ procedure }).catch((v) => v)
    expect(result).toBeInstanceOf(ApiError)
    expect(result).toHaveProperty('code', ErrorCode.Forbidden)
  })

  it('should handle middleware', async () => {
    const middleware1Fn = vi.fn(async (ctx, next, payload) => {
      const result = await next({ test: `${payload.test}2` })
      return { test: `${result.test}_middleware1` }
    })
    const middleware2Fn = vi.fn(async (ctx, next, payload) => {
      const result = await next({ test: `${payload.test}3` })
      return { test: `${result.test}_middleware2` }
    })

    const handlerFn = vi.fn(() => ({ test: 'result' }))

    const middleware1 = new Middleware().withValue(middleware1Fn)
    const middleware2 = new Middleware().withValue(middleware2Fn)
    const procedure = testProcedure()
      .withMiddlewares(middleware1, middleware2)
      .withHandler(handlerFn)

    service.implement('testProcedure', procedure)

    const response = await call({ procedure, payload: { test: '1' } })

    expect(middleware1Fn).toHaveBeenCalledWith(
      {
        connection,
        container,
        procedure,
        service,
      },
      expect.any(Function),
      { test: '1' },
    )
    expect(middleware2Fn).toHaveBeenCalledWith(
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

  it('should find procedure', () => {
    const procedure = testProcedure().withHandler(() => 'result')
    service.implement('testProcedure', procedure)
    const found = api.find(service.contract.name, 'testProcedure', transport)
    expect(found).toHaveProperty('service', service)
    expect(found).toHaveProperty('procedure', procedure)
  })
})
