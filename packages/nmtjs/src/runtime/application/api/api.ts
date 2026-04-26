import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import { inspect } from 'node:util'

import type {
  AnyFactoryMetaBinding,
  AnyMetaBinding,
  Container,
  Logger,
  StaticMetaBinding,
} from '@nmtjs/core'
import type {
  GatewayApi,
  GatewayApiCallOptions,
  GatewayApiCallResult,
  GatewayConnection,
  GatewayResolvedProcedure,
  GatewayResolveOptions,
} from '@nmtjs/gateway'
import { withTimeout } from '@nmtjs/common'
import { IsStreamProcedureContract } from '@nmtjs/contract'
import {
  getMetaBindingMeta,
  getStaticMetaValue,
  isStaticMetaBinding,
  Scope,
} from '@nmtjs/core'
import {
  createGatewayStaticMetaView,
  isAsyncIterable,
  rpcStreamAbortSignal,
} from '@nmtjs/gateway'
import { ErrorCode } from '@nmtjs/protocol'
import { ProtocolError } from '@nmtjs/protocol/server'
import { NeemataTypeError, registerDefaultLocale, type } from '@nmtjs/type'
import { prettifyError } from 'zod/mini'

import type { RuntimeConfig } from './config.ts'
import type { kDefaultProcedure as kDefaultProcedureKey } from './constants.ts'
import type { AnyFilter } from './filters.ts'
import type { AnyGuard } from './guards.ts'
import type { ApiMetaContext } from './meta.ts'
import type { AnyMiddleware } from './middlewares.ts'
import type { AnyProcedure } from './procedure.ts'
import type { AnyRouter } from './router.ts'
import type { ApiCallContext } from './types.ts'
import { config, defaultRuntimeConfig } from './config.ts'
import { kDefaultProcedure } from './constants.ts'

registerDefaultLocale()

export type ApiCallOptions<T extends AnyProcedure = AnyProcedure> = Readonly<{
  callId: string
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
  meta: readonly AnyMetaBinding[]
  guards: Set<AnyGuard>
  middlewares: Set<AnyMiddleware>
  filters: Set<AnyFilter>
}

type ResolvedMetaBindings = Readonly<{
  static: readonly StaticMetaBinding[]
  beforeDecode: readonly AnyFactoryMetaBinding[]
  afterDecode: readonly AnyFactoryMetaBinding[]
  config: Required<RuntimeConfig>
}>

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

  async resolve(
    options: GatewayResolveOptions,
  ): Promise<GatewayResolvedProcedure> {
    const { procedure, path } = this.find(options.procedure)

    const metaBindings = this.resolveMetaBindings(path, procedure)

    return Object.freeze({
      stream: IsStreamProcedureContract(procedure.contract),
      meta: createGatewayStaticMetaView(metaBindings.static),
    }) satisfies GatewayResolvedProcedure
  }

  async call(options: GatewayApiCallOptions): Promise<GatewayApiCallResult> {
    const callId = randomUUID()

    const { payload, container, signal, connection } = options

    assert(
      container.scope === Scope.Call,
      'Invalid container scope, expected to be Scope.Call',
    )

    const { procedure, path } = this.find(options.procedure)

    const metaBindings = this.resolveMetaBindings(path, procedure)

    const callOptions: ApiCallOptions = Object.freeze({
      callId,
      payload,
      container,
      signal,
      connection,
      procedure,
      path,
    })

    const timeout = procedure.contract.timeout ?? this.options.timeout
    const streamTimeoutSignal = procedure.streamTimeout
      ? AbortSignal.timeout(procedure.streamTimeout)
      : undefined

    if (streamTimeoutSignal) {
      container.provide(rpcStreamAbortSignal, streamTimeoutSignal)
    }

    try {
      const handle = await this.createProcedureHandler(
        callOptions,
        metaBindings,
      )
      return timeout
        ? await this.withTimeout(handle(payload), timeout)
        : await handle(payload)
    } catch (error) {
      const handled = await this.handleFilters(callOptions, error)
      if (handled === error && error instanceof ProtocolError === false) {
        const logError = new Error('Unhandled error', { cause: error })
        this.options.logger.error(logError)
        throw new ApiError(
          ErrorCode.InternalServerError,
          'Internal Server Error',
        )
      }
      throw handled
    }
  }

  private async createProcedureHandler(
    callOptions: ApiCallOptions,
    metaBindings: ResolvedMetaBindings,
  ) {
    const { callId, connection, procedure, container, path } = callOptions

    const callCtx: ApiCallContext = Object.freeze({
      callId,
      connection,
      container,
      path,
      procedure,
    })

    const isIterableProcedure = IsStreamProcedureContract(procedure.contract)

    this.applyStaticMetaBindings(container, metaBindings.static)

    const middlewares = this.resolveMiddlewares(callOptions)

    const handleProcedure = async (payload: any) => {
      const middleware = (await middlewares).next().value
      if (middleware) {
        const next = (...args: any[]) =>
          handleProcedure(args.length === 0 ? payload : args[0])
        return middleware.handle(middleware.ctx, callCtx, next, payload)
      } else {
        await this.applyFactoryMetaBindings(
          container,
          metaBindings.beforeDecode,
          callCtx,
          payload,
        )
        const input = this.handleInput(procedure, payload)
        await this.applyFactoryMetaBindings(
          container,
          metaBindings.afterDecode,
          callCtx,
          input,
        )
        await this.handleGuards(callOptions, callCtx, input)
        const { dependencies, handler } = procedure
        const context = await container.createContext(dependencies)
        const result = await handler(context, input)
        if (isIterableProcedure) {
          return this.handleIterableOutput(
            procedure,
            result,
            metaBindings.config,
          )
        } else {
          return this.handleOutput(procedure, result, metaBindings.config)
        }
      }
    }

    return handleProcedure
  }

  private resolveMetaBindings(
    path: AnyRouter[],
    procedure: AnyProcedure,
  ): ResolvedMetaBindings {
    const bindings = [
      ...this.options.meta,
      ...path.flatMap((router) => router.meta),
      ...procedure.meta,
    ]

    const staticBindings: StaticMetaBinding[] = []
    const beforeDecode: AnyFactoryMetaBinding[] = []
    const afterDecode: AnyFactoryMetaBinding[] = []

    for (const binding of bindings) {
      if (isStaticMetaBinding(binding)) {
        staticBindings.push(binding)
      } else if (binding.phase === 'afterDecode') {
        afterDecode.push(binding)
      } else {
        beforeDecode.push(binding)
      }
    }

    const runtimeConfig = getStaticMetaValue(staticBindings, config)

    return Object.freeze({
      static: Object.freeze(staticBindings),
      beforeDecode: Object.freeze(beforeDecode),
      afterDecode: Object.freeze(afterDecode),
      config: Object.freeze({ ...defaultRuntimeConfig, ...runtimeConfig }),
    })
  }

  private applyStaticMetaBindings(
    container: Container,
    bindings: readonly StaticMetaBinding[],
  ) {
    for (const binding of bindings) {
      container.provide(getMetaBindingMeta(binding), binding.value)
    }
  }

  private async applyFactoryMetaBindings(
    container: Container,
    bindings: readonly AnyFactoryMetaBinding[],
    callCtx: ApiMetaContext,
    input: unknown,
  ) {
    for (const binding of bindings) {
      const context = await container.createContext(binding.dependencies)
      const value = await binding.resolve(context, callCtx, input)
      container.provide(getMetaBindingMeta(binding), value)
    }
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
    payload: any,
  ) {
    const { path, procedure, container } = callOptions
    const guards = [
      ...this.options.guards,
      ...path.flatMap((router) => [...router.guards]),
      ...procedure.guards,
    ]
    for (const guard of guards) {
      const ctx = await container.createContext(guard.dependencies)
      const result = await guard.can(
        ctx,
        Object.freeze({ ...callCtx, payload }),
      )
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

  private handleIterableOutput(
    procedure: AnyProcedure,
    response: any,
    runtimeConfig: Required<RuntimeConfig>,
  ) {
    if (!isAsyncIterable(response))
      throw new Error('Response is an async iterable')
    const chunkType = procedure.contract.output
    if (chunkType instanceof type.NeverType)
      throw new Error('Stream procedure must have a defined output type')

    return async function* (onDone?: () => void) {
      try {
        if (runtimeConfig.serializeOutput === false) {
          yield* response
        } else if (chunkType instanceof type.AnyType === false) {
          for await (const chunk of response) {
            yield chunkType.encode(chunk)
          }
        } else {
          yield* response
        }
      } finally {
        onDone?.()
      }
    }
  }

  private handleOutput(
    procedure: AnyProcedure,
    response: any,
    runtimeConfig: Required<RuntimeConfig>,
  ) {
    if (procedure.contract.output instanceof type.NeverType === false) {
      if (runtimeConfig.serializeOutput === false) return response
      const type = procedure.contract.output
      return type.encode(response)
    }
    return undefined
  }
}
