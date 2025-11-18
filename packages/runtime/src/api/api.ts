import assert from 'node:assert'
import { inspect } from 'node:util'

import type { Async, ErrorClass } from '@nmtjs/common'
import type {
  AnyInjectable,
  Container,
  Dependencies,
  Logger,
} from '@nmtjs/core'
import type {
  Connection,
  ProtocolApi,
  ProtocolApiCallIterableResult,
  ProtocolApiCallOptions,
  ProtocolApiCallResult,
  Transport,
  TransportPlugin,
} from '@nmtjs/protocol/server'
import { withTimeout } from '@nmtjs/common'
import { IsStreamProcedureContract } from '@nmtjs/contract'
import { createFactoryInjectable, Scope } from '@nmtjs/core'
import { ErrorCode } from '@nmtjs/protocol'
import {
  createStreamResponse,
  isIterable,
  ProtocolError,
  ProtocolInjectables,
} from '@nmtjs/protocol/server'
import { NeemataTypeError, type } from '@nmtjs/type'
import { prettifyError } from 'zod/mini'

import type { AnyProcedure } from './procedure.ts'
import type { ApiRegistry } from './registry.ts'
import type { AnyRouter } from './router.ts'
import type { ApiCallContext } from './types.ts'

export type FilterLike<T extends ErrorClass = ErrorClass> = {
  catch(error: InstanceType<T>): Async<Error>
}

export type AnyFilter<Error extends ErrorClass = ErrorClass> = AnyInjectable<
  FilterLike<Error>
>

export type GuardLike = { can(context: ApiCallContext): Async<boolean> }

export type AnyGuard = AnyInjectable<GuardLike>

export type MiddlewareNext = (payload?: any) => any

export type MiddlewareLike = {
  handle(context: ApiCallContext, next: MiddlewareNext, payload: any): any
}

export type AnyMiddleware = AnyInjectable<MiddlewareLike>

export type ApiCallOptions<T extends AnyProcedure = AnyProcedure> = Readonly<{
  connection: Connection
  path: AnyRouter[]
  procedure: T
  container: Container
  payload: any
  signal: AbortSignal
}>

export type ApiOptions = { timeout: number }

export class ApiError extends ProtocolError {
  toString() {
    return `${this.code} ${this.message}: \n${inspect(this.data, true, 10, false)}`
  }
}

const NotFound = () => new ApiError(ErrorCode.NotFound, 'Procedure not found')

export const createMiddleware = <
  D extends Dependencies = {},
  S extends Scope = Scope.Global,
>(
  ...args: Parameters<typeof createFactoryInjectable<MiddlewareLike, D, S>>
) => createFactoryInjectable(...args)

export const createGuard = <
  D extends Dependencies = {},
  S extends Scope = Scope.Global,
>(
  ...args: Parameters<typeof createFactoryInjectable<GuardLike, D, S>>
) => createFactoryInjectable(...args)

export const createFilter = <
  D extends Dependencies = {},
  S extends Scope = Scope.Global,
>(
  ...args: Parameters<typeof createFactoryInjectable<FilterLike, D, S>>
) => createFactoryInjectable(...args)

export class Api implements ProtocolApi {
  readonly definitions: Array<[TransportPlugin, any]> = []
  readonly transports = new Set<Transport>()
  readonly connections = new Map<string, Connection>()

  constructor(
    private readonly runtime: {
      container: Container
      registry: ApiRegistry
      logger: Logger
    },
    private readonly options: ApiOptions,
  ) {}

  find(procedureName: string) {
    const result = this.runtime.registry.procedures.get(procedureName)
    if (result) return result
    throw NotFound()
  }

  async call(options: ProtocolApiCallOptions): Promise<ProtocolApiCallResult> {
    const { payload, container, signal, connection } = options

    const { procedure, path } = this.find(options.procedure)

    options.validateMetadata?.(procedure.metadata)

    const callOptions = Object.freeze({
      payload,
      container,
      signal,
      connection,
      procedure,
      path,
    })

    assert(
      container.scope === Scope.Call,
      'Invalid container scope, expected to be Scope.Call',
    )

    const timeout = procedure.contract.timeout || this.options.timeout

    const timeoutController = new AbortController()
    const timeoutSignal =
      timeout && timeout > 0
        ? AbortSignal.any([
            AbortSignal.timeout(timeout),
            timeoutController.signal,
          ])
        : timeoutController.signal

    container.provide(ProtocolInjectables.rpcTimeoutSignal, timeoutSignal)
    container.provide(ProtocolInjectables.rpcClientAbortSignal, signal)
    container.provide(ProtocolInjectables.connection, connection)

    const isIterableProcedure = IsStreamProcedureContract(procedure.contract)

    try {
      const handler = await this.createProcedureHandler(callOptions)
      const result = await this.handleTimeout(
        handler(payload),
        timeout,
        timeoutController,
      )
      if (isIterableProcedure) {
        return this.handleIterableOutput(procedure, result)
      } else {
        return this.handleOutput(procedure, result)
      }
    } catch (error) {
      const handled = await this.handleFilters(error)
      if (handled === error && error instanceof ProtocolError === false) {
        const logError = new Error('Unhandled error', { cause: error })
        this.runtime.logger.error(logError)
        throw new ApiError(
          ErrorCode.InternalServerError,
          'Internal Server Error',
        )
      }
      throw handled
    }
  }

  private async createProcedureHandler(callOptions: ApiCallOptions) {
    const { connection, procedure, container, path } = callOptions

    const callCtx: ApiCallContext = Object.freeze({
      connection,
      container,
      path,
      procedure,
    })

    const middlewares = await this.resolveMiddlewares(callOptions)

    const handleProcedure = async (payload: any) => {
      const middleware = middlewares.next().value as MiddlewareLike | undefined
      if (middleware) {
        const next = (...args: any[]) =>
          handleProcedure(args.length === 0 ? payload : args[0])
        return middleware.handle(callCtx, next, payload)
      } else {
        const guards = await this.resolveGuards(callOptions)
        await this.handleGuards(callOptions, callCtx, guards)
        const { dependencies } = procedure
        const context = await container.createContext(dependencies)
        const input = this.handleInput(procedure, payload)
        const result = await procedure.handler(context, input)
        return result
      }
    }

    return handleProcedure
  }

  private async resolveMiddlewares(callOptions: ApiCallOptions) {
    const { path, procedure, container } = callOptions
    const middlewareInjectables = [
      ...this.runtime.registry.middlewares,
      ...path.flatMap((router) => [...router.middlewares]),
      ...procedure.middlewares,
    ]
    const middlewares = await Promise.all(
      middlewareInjectables.map((p) => container.resolve(p)),
    )
    return middlewares[Symbol.iterator]()
  }

  private async resolveGuards(callOptions: ApiCallOptions) {
    const { path, procedure, container } = callOptions
    const injectables = [
      ...this.runtime.registry.guards,
      ...path.flatMap((router) => [...router.guards]),
      ...procedure.guards,
    ]
    return await Promise.all(injectables.map((p) => container.resolve(p)))
  }

  private handleTimeout(
    response: any,
    timeout: number,
    controller: AbortController,
  ): unknown {
    const applyTimeout = response instanceof Promise && timeout && timeout > 0
    if (!applyTimeout) return response
    return withTimeout(
      response,
      timeout,
      new ApiError(ErrorCode.RequestTimeout, 'Request Timeout'),
      controller,
    )
  }

  private async handleGuards(
    _callOptions: ApiCallOptions,
    callCtx: ApiCallContext,
    guards: Iterable<GuardLike>,
  ) {
    for (const guard of guards) {
      const result = await guard.can(callCtx)
      if (result === false) throw new ApiError(ErrorCode.Forbidden)
    }
  }

  private async handleFilters(error: any) {
    if (this.runtime.registry.filters.size) {
      for (const [errorType, filter] of this.runtime.registry.filters) {
        if (error instanceof errorType) {
          const filterLike = await this.runtime.container.resolve(filter)
          const handledError = await filterLike.catch(error)
          if (!handledError || !(handledError instanceof ApiError)) continue
          return handledError
        }
      }
    }

    return error
  }

  private handleInput(procedure: AnyProcedure, payload: any) {
    if (procedure.contract.input instanceof type.NeverType === false) {
      const type = procedure.contract.input
      try {
        return type.decode(payload)
      } catch (error) {
        if (error instanceof NeemataTypeError)
          throw new ApiError(
            ErrorCode.ValidationError,
            `Input validation error: \n${prettifyError(error)}`,
            error.issues,
          )
        throw error
      }
    }
  }

  private handleIterableOutput(
    procedure: AnyProcedure,
    response: any,
  ): ProtocolApiCallIterableResult {
    if (!isIterable(response))
      throw new Error('Invalid response. Use `createIterableResponse` helper')
    const iterable = response.iterable
    if (procedure.contract.output instanceof type.NeverType === false) {
      const type = procedure.contract.output
      const output = type.encode(response.output)
      return createStreamResponse(iterable, output, response.onFinish)
    }
    return createStreamResponse(iterable, undefined, response.onFinish)
  }

  private handleOutput(procedure: AnyProcedure, response: any) {
    if (procedure.contract.output instanceof type.NeverType === false) {
      const type = procedure.contract.output
      return { output: type.encode(response) }
    }
    return { output: undefined }
  }
}
