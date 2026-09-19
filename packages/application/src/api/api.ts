import { randomUUID } from 'node:crypto'
import { inspect } from 'node:util'

import type { TAnyCallableContract, TAnyRouterContract } from '@nmtjs/contract'
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
  GatewayResolvedProcedure,
  GatewayResolveOptions,
  GatewayStaticMetaView,
} from '@nmtjs/gateway'
import { isAsyncIterable, withTimeout } from '@nmtjs/common'
import { IsStreamContract } from '@nmtjs/contract'
import {
  getMetaBindingMeta,
  getStaticMetaValue,
  isStaticMetaBinding,
  Scope,
} from '@nmtjs/core'
import {
  createGatewayStaticMetaView,
  rpcStreamAbortSignal,
  rpcTimeoutSignal,
} from '@nmtjs/gateway'
import { ErrorCode } from '@nmtjs/protocol'
import { ProtocolError } from '@nmtjs/protocol/server'
import { NeemataTypeError, registerDefaultLocale, type } from '@nmtjs/type'
import { prettifyError } from 'zod/mini'

import type { RuntimeConfig } from './config.ts'
import type { AnyFilter } from './filters.ts'
import type { AnyGuard } from './guards.ts'
import type { ApiMetaContext } from './meta.ts'
import type { AnyMiddleware } from './middlewares.ts'
import type { AnyProcedure } from './procedure.ts'
import type { AnyRouter } from './router.ts'
import type { ApiCallContext } from './types.ts'
import { config, defaultRuntimeConfig } from './config.ts'

// zod messages are locale-driven; without a registered locale prettifyError()
// renders empty strings in the input validation errors below
registerDefaultLocale()

export type ApplicationResolvedRouter = Readonly<{
  contract: TAnyRouterContract
  timeout?: number
}>

export type ApplicationResolvedProcedureDescriptor = Readonly<{
  name: string
  contract: TAnyCallableContract
  stream: boolean
  streamTimeout?: number
}>

export interface ApplicationResolvedProcedure extends GatewayResolvedProcedure {
  readonly meta: GatewayStaticMetaView
  readonly procedure: ApplicationResolvedProcedureDescriptor
  readonly path: readonly ApplicationResolvedRouter[]
}

export type ApiOptions = {
  timeout?: number
  logger: Logger
  procedures: Map<string, { procedure: AnyProcedure; path: AnyRouter[] }>
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

export class ApplicationApi implements GatewayApi<ApplicationResolvedProcedure> {
  constructor(public options: ApiOptions) {}

  find(procedureName: string) {
    const procedure = this.options.procedures.get(procedureName)
    if (procedure) return procedure

    throw new ApiError(
      ErrorCode.NotFound,
      `Procedure not found: ${procedureName}`,
    )
  }

  async resolve(
    options: GatewayResolveOptions,
  ): Promise<ApplicationResolvedProcedure> {
    const { procedure, path: routers } = this.find(options.procedure)

    const bindings = this.resolveMetaBindings(routers, procedure)
    const stream = IsStreamContract(procedure.contract)
    const name = procedure.contract.name ?? options.procedure
    const meta = createGatewayStaticMetaView(bindings.static)
    const descriptor = Object.freeze({
      name,
      contract: procedure.contract,
      stream,
      streamTimeout: procedure.streamTimeout,
    })
    const path = Object.freeze(
      routers.map(({ contract, timeout }) =>
        Object.freeze({ contract, timeout }),
      ),
    )

    return Object.freeze({
      name,
      stream,
      meta,
      procedure: descriptor,
      path,
    }) satisfies ApplicationResolvedProcedure
  }

  async call(options: GatewayApiCallOptions): Promise<GatewayApiCallResult> {
    const { payload, container, connection } = options

    if (container.scope !== Scope.Call) {
      throw new Error('Invalid container scope, expected to be Scope.Call')
    }

    const { procedure, path } = this.find(options.procedure)

    const metaBindings = this.resolveMetaBindings(path, procedure)

    const ctx: ApiCallContext = Object.freeze({
      callId: randomUUID(),
      connection,
      container,
      path,
      procedure,
    })

    const timeoutMs = procedure.contract.timeout ?? this.options.timeout
    // the controller is paired with the timeout so a timed out handler is
    // actually aborted, not just raced away
    const timeout =
      timeoutMs && timeoutMs > 0
        ? { ms: timeoutMs, controller: new AbortController() }
        : undefined

    if (procedure.streamTimeout) {
      container.provide(
        rpcStreamAbortSignal,
        AbortSignal.timeout(procedure.streamTimeout),
      )
    }

    if (timeout) {
      container.provide(rpcTimeoutSignal, timeout.controller.signal)
    }

    try {
      const handle = await this.createProcedureHandler(ctx, metaBindings)
      if (!timeout) return await handle(payload)
      return await withTimeout(
        handle(payload),
        timeout.ms,
        new ApiError(ErrorCode.RequestTimeout, 'Request Timeout'),
        timeout.controller,
      )
    } catch (error) {
      const handled = await this.handleFilters(container, error)
      // plain Errors are not wire-safe: log them and respond with a generic
      // server error instead of leaking internals
      if (!(handled instanceof ProtocolError)) {
        const logError = new Error('Unhandled error', { cause: handled })
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
    ctx: ApiCallContext,
    metaBindings: ResolvedMetaBindings,
  ) {
    const { procedure, container } = ctx
    const stream = IsStreamContract(procedure.contract)

    this.applyStaticMetaBindings(container, metaBindings.static)

    // awaited inside dispatch, not here, so middleware dependency resolution
    // stays inside the call timeout window
    const middlewares = this.resolveMiddlewares(ctx)

    const dispatch = async (index: number, payload: any) => {
      const middleware = (await middlewares)[index]
      if (middleware) {
        // next() forwards the payload the middleware received; next(value) —
        // next(undefined) included — replaces it
        const next = (...args: any[]) =>
          dispatch(index + 1, args.length === 0 ? payload : args[0])
        return middleware.handler(middleware.context, ctx, next, payload)
      }

      await this.applyFactoryMetaBindings(
        container,
        metaBindings.beforeDecode,
        ctx,
        payload,
      )
      const input = this.handleInput(procedure, payload)
      await this.applyFactoryMetaBindings(
        container,
        metaBindings.afterDecode,
        ctx,
        input,
      )
      await this.handleGuards(ctx, input)
      const { dependencies, handler } = procedure
      const context = await container.createContext(dependencies)
      const result = await handler(context, input)
      if (stream) {
        return this.handleIterableOutput(procedure, result, metaBindings.config)
      }
      return this.handleOutput(procedure, result, metaBindings.config)
    }

    return (payload: any) => dispatch(0, payload)
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
      const value = await binding.handler(context, callCtx, input)
      container.provide(getMetaBindingMeta(binding), value)
    }
  }

  private async resolveMiddlewares(ctx: ApiCallContext) {
    const { path, procedure, container } = ctx
    const middlewares = [
      ...this.options.middlewares,
      ...path.flatMap((router) => [...router.middlewares]),
      ...procedure.middlewares,
    ]
    return await Promise.all(
      middlewares.map(async (middleware) => {
        const context = await container.createContext(middleware.dependencies)
        return { handler: middleware.handler, context }
      }),
    )
  }

  private async handleGuards(ctx: ApiCallContext, payload: any) {
    const { path, procedure, container } = ctx
    const guards = [
      ...this.options.guards,
      ...path.flatMap((router) => [...router.guards]),
      ...procedure.guards,
    ]
    if (!guards.length) return

    const guardCtx = Object.freeze({ ...ctx, payload })
    for (const guard of guards) {
      const context = await container.createContext(guard.dependencies)
      const result = await guard.handler(context, guardCtx)
      if (result === false) throw new ApiError(ErrorCode.Forbidden)
    }
  }

  private async handleFilters(container: Container, error: any) {
    for (const filter of this.options.filters) {
      if (!(error instanceof filter.errorClass)) continue

      const ctx = await container.createContext(filter.dependencies)
      // accept any Error, as the Filter type promises; non-ProtocolError
      // results are sanitized on the way out by call()
      const handled = await filter.handler(ctx, error)
      if (handled instanceof Error) return handled
    }
    return error
  }

  private handleInput(procedure: AnyProcedure, payload: any) {
    const { input } = procedure.contract
    if (input instanceof type.NeverType) return

    try {
      return input.decode(payload)
    } catch (error) {
      if (error instanceof NeemataTypeError) {
        throw new ApiError(
          ErrorCode.ValidationError,
          `Input validation error: \n${prettifyError(error)}`,
          error.issues,
        )
      }
      throw error
    }
  }

  private handleIterableOutput(
    procedure: AnyProcedure,
    response: any,
    runtimeConfig: Required<RuntimeConfig>,
  ) {
    if (!isAsyncIterable(response))
      throw new Error('Response is not an async iterable')
    const chunkType = procedure.contract.output
    if (chunkType instanceof type.NeverType)
      throw new Error('Stream procedure must have a defined output type')

    // only an explicit `false` opts out; an unset value keeps encoding on
    const encode =
      runtimeConfig.serializeOutput !== false &&
      !(chunkType instanceof type.AnyType)

    return async function* (onDone?: () => void) {
      try {
        if (encode) {
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
    const { output } = procedure.contract
    if (output instanceof type.NeverType) return undefined
    if (runtimeConfig.serializeOutput === false) return response
    return output.encode(response)
  }
}
