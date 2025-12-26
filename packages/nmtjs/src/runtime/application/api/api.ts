import assert from 'node:assert'
import { inspect } from 'node:util'

import type { Container, Logger } from '@nmtjs/core'
import type {
  GatewayApi,
  GatewayApiCallOptions,
  GatewayApiCallResult,
  GatewayConnection,
} from '@nmtjs/gateway'
import { withTimeout } from '@nmtjs/common'
import { IsStreamProcedureContract } from '@nmtjs/contract'
import { Scope } from '@nmtjs/core'
import { isAsyncIterable, rpcStreamAbortSignal } from '@nmtjs/gateway'
import { ErrorCode } from '@nmtjs/protocol'
import { ProtocolError } from '@nmtjs/protocol/server'
import { NeemataTypeError, registerDefaultLocale, type } from '@nmtjs/type'
import { prettifyError } from 'zod/mini'

import type { kDefaultProcedure as kDefaultProcedureKey } from './constants.ts'
import type { AnyFilter } from './filters.ts'
import type { AnyGuard } from './guards.ts'
import type { AnyMiddleware } from './middlewares.ts'
import type { AnyProcedure } from './procedure.ts'
import type { AnyRouter } from './router.ts'
import type { ApiCallContext } from './types.ts'
import { kDefaultProcedure } from './constants.ts'

registerDefaultLocale()

export type ApiCallOptions<T extends AnyProcedure = AnyProcedure> = Readonly<{
  connection: GatewayConnection
  path: AnyRouter[]
  procedure: T
  container: Container
  payload: any
  signal: AbortSignal
}>

export type ApiOptions = {
  timeout?: number
  container: Container
  logger: Logger
  procedures: Map<
    string | kDefaultProcedureKey,
    { procedure: AnyProcedure; path: AnyRouter[] }
  >
  guards: Set<AnyGuard>
  middlewares: Set<AnyMiddleware>
  filters: Set<AnyFilter>
}

export class ApiError extends ProtocolError {
  toString() {
    return `${this.code} ${this.message}: \n${inspect(this.data, true, 10, false)}`
  }
}

const NotFound = () => new ApiError(ErrorCode.NotFound, 'Procedure not found')

export class ApplicationApi implements GatewayApi {
  constructor(public options: ApiOptions) {}

  find(procedureName: string) {
    const procedure = this.options.procedures.get(procedureName)
    if (procedure) return procedure

    const fallback = this.options.procedures.get(kDefaultProcedure)
    if (fallback) return fallback

    throw NotFound()
  }

  async call(options: GatewayApiCallOptions): Promise<GatewayApiCallResult> {
    const { payload, container, signal, connection } = options

    const { procedure, path } = this.find(options.procedure)

    options.metadata?.(procedure.metadata)

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

    const timeout = procedure.contract.timeout ?? this.options.timeout
    const isIterableProcedure = IsStreamProcedureContract(procedure.contract)
    const streamTimeoutSignal = procedure.streamTimeout
      ? AbortSignal.timeout(procedure.streamTimeout)
      : undefined

    if (streamTimeoutSignal) {
      container.provide(rpcStreamAbortSignal, streamTimeoutSignal)
    }

    try {
      const handle = await this.createProcedureHandler(callOptions)
      const result = timeout
        ? await this.withTimeout(handle(payload), timeout)
        : await handle(payload)
      if (isIterableProcedure) {
        return this.handleIterableOutput(procedure, result)
      } else {
        return this.handleOutput(procedure, result)
      }
    } catch (error) {
      const handled = await this.handleFilters(callOptions, error)
      if (handled === error && error instanceof ProtocolError === false) {
        const logError = new Error('Unhandled error', { cause: error })
        this.options.logger.debug(logError)
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
      const middleware = middlewares.next().value
      if (middleware) {
        const next = (...args: any[]) =>
          handleProcedure(args.length === 0 ? payload : args[0])
        return middleware.handle(middleware.ctx, callCtx, next, payload)
      } else {
        await this.handleGuards(callOptions, callCtx)
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
    const middlewares = [
      ...this.options.middlewares,
      ...path.flatMap((router) => [...router.middlewares]),
      ...procedure.middlewares,
    ]
    const result = await Promise.all(
      middlewares.map(async (middleware) => {
        const ctx = await container.createContext(middleware.dependencies)
        return { handle: middleware.handle, ctx }
      }),
    )
    return result[Symbol.iterator]()
  }

  private withTimeout(response: any, timeout: number): unknown {
    const applyTimeout = response instanceof Promise && timeout > 0
    if (!applyTimeout) return response
    return withTimeout(
      response,
      timeout,
      new ApiError(ErrorCode.RequestTimeout, 'Request Timeout'),
    )
  }

  private async handleGuards(
    callOptions: ApiCallOptions,
    callCtx: ApiCallContext,
  ) {
    const { path, procedure, container } = callOptions
    const guards = [
      ...this.options.guards,
      ...path.flatMap((router) => [...router.guards]),
      ...procedure.guards,
    ]
    for (const guard of guards) {
      const ctx = await container.createContext(guard.dependencies)
      const result = await guard.can(ctx, callCtx)
      if (result === false) throw new ApiError(ErrorCode.Forbidden)
    }
  }

  private async handleFilters({ container }: ApiCallOptions, error: any) {
    if (this.options.filters.size) {
      for (const filter of this.options.filters) {
        if (error instanceof filter.errorClass) {
          const ctx = await container.createContext(filter.dependencies)
          const handledError = await filter.catch(ctx, error)
          if (!handledError || handledError instanceof ApiError === false)
            continue
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

  private handleIterableOutput(procedure: AnyProcedure, response: any) {
    if (!isAsyncIterable(response))
      throw new Error('Response is an async iterable')
    const chunkType = procedure.contract.output
    if (chunkType instanceof type.NeverType)
      throw new Error('Stream procedure must have a defined output type')

    return async function* (onDone?: () => void) {
      try {
        if (chunkType instanceof type.AnyType === false) {
          for await (const chunk of response) {
            const encoded = chunkType.encode(chunk)
            yield encoded
          }
        } else {
          yield* response
        }
      } finally {
        onDone?.()
      }
    }
  }

  private handleOutput(procedure: AnyProcedure, response: any) {
    if (procedure.contract.output instanceof type.NeverType === false) {
      const type = procedure.contract.output
      return type.encode(response)
    }
    return undefined
  }
}
