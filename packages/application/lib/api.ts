import { type BaseType, NeverType } from '@nmtjs/type'

import assert from 'node:assert'
import { inspect } from 'node:util'
import { withTimeout } from '@nmtjs/common'
import { IsProcedureContract, IsSubscriptionContract } from '@nmtjs/contract'
import { type AnyInjectable, type Container, Scope } from '@nmtjs/core'
import {
  type Dependencies,
  type Logger,
  createFactoryInjectable,
} from '@nmtjs/core'
import { ErrorCode, ProtocolBlob } from '@nmtjs/protocol/common'
import {
  type Connection,
  type ProtocolApi,
  type ProtocolApiCallOptions,
  type ProtocolApiCallResult,
  ProtocolClientStream,
  ProtocolError,
  ProtocolInjectables,
  ProtocolServerStream,
} from '@nmtjs/protocol/server'
import type { ApplicationOptions } from './application.ts'
import { kIterableResponse } from './constants.ts'
import type { AnyNamespace } from './namespace.ts'
import type { AnyBaseProcedure } from './procedure.ts'
import type { ApplicationRegistry } from './registry.ts'
import type { ApiCallContext, Async, ErrorClass } from './types.ts'

const cloneOptions = {
  exclude: new Set([ProtocolServerStream, ProtocolClientStream, ProtocolBlob]),
}
export interface FilterLike<T extends ErrorClass = ErrorClass> {
  catch(error: InstanceType<T>): Async<Error>
  [k: string]: any
}

export type AnyFilter<Error extends ErrorClass = ErrorClass> = AnyInjectable<
  FilterLike<Error>
>

export interface GuardLike {
  can(context: ApiCallContext): Async<boolean>
  [k: string]: any
}

export type AnyGuard = AnyInjectable<GuardLike>

export type MiddlewareNext = (payload?: any) => any

export interface MiddlewareLike {
  handle(context: ApiCallContext, next: MiddlewareNext, payload: any): any
  [k: string]: any
}

export type AnyMiddleware = AnyInjectable<MiddlewareLike>

export type ApplicationApiCallOptions<
  T extends AnyBaseProcedure = AnyBaseProcedure,
> = {
  connection: Connection
  namespace: AnyNamespace
  procedure: T
  container: Container
  payload: any
  signal: AbortSignal
}

export class Api implements ProtocolApi {
  constructor(
    private readonly application: {
      container: Container
      registry: ApplicationRegistry
      logger: Logger
    },
    private readonly options: ApplicationOptions['api'],
  ) {}

  /**
   * @throws {ApplicationApiError}
   */
  find(namespaceName: string, procedureName: string) {
    const namespace = this.application.registry.namespaces.get(namespaceName)
    if (namespace) {
      const procedure = namespace.procedures.get(procedureName)
      if (procedure) return { namespace, procedure }
    }
    throw NotFound()
  }

  async call(options: ProtocolApiCallOptions): Promise<ProtocolApiCallResult> {
    const { payload, container, signal, connection } = options

    const { namespace, procedure } = this.find(
      options.namespace,
      options.procedure,
    )

    const callOptions = {
      payload,
      container,
      signal,
      connection,
      namespace,
      procedure,
    }

    assert(
      container.scope === Scope.Call,
      'Invalid container scope, expected to be Scope.Call',
    )

    const timeout =
      procedure.contract.timeout ||
      namespace.contract.timeout ||
      this.options.timeout

    const timeoutController = new AbortController()
    const timeoutSignal =
      timeout && timeout > 0
        ? AbortSignal.any([
            AbortSignal.timeout(timeout),
            timeoutController.signal,
          ])
        : timeoutController.signal

    container.provide(ProtocolInjectables.rpcAbortSignal, timeoutSignal)
    container.provide(ProtocolInjectables.rpcClientAbortSignal, signal)
    container.provide(ProtocolInjectables.connection, connection)

    const isSubscription = IsSubscriptionContract(procedure.contract)
    const isIterableProcedure =
      IsProcedureContract(procedure.contract) &&
      procedure.contract.stream instanceof NeverType === false

    try {
      const handler = await this.createProcedureHandler(
        callOptions,
        timeout,
        timeoutController,
      )
      const result = await handler(payload)
      if (isSubscription) {
        // return this.handleSubscriptionOutput(callOptions, result)
        throw new Error('Unimplemented')
      } else if (isIterableProcedure) {
        return this.handleIterableOutput(procedure, result)
      } else {
        return this.handleOutput(procedure, result)
      }
    } catch (error) {
      const logError = new Error('Unhandled error', { cause: error })
      this.application.logger.error(logError)
      throw await this.handleFilters(error)
    }
  }

  private async createProcedureHandler(
    callOptions: ApplicationApiCallOptions,
    timeout: number,
    timeoutController: AbortController,
  ) {
    const { connection, procedure, container, namespace } = callOptions

    const callCtx: ApiCallContext = Object.freeze({
      connection,
      container,
      namespace,
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
        const result = await this.handleTimeout(
          procedure.handler(context, input),
          timeout,
          timeoutController,
        )
        return result
      }
    }

    return handleProcedure
  }

  private async resolveMiddlewares(callOptions: ApplicationApiCallOptions) {
    const { namespace, procedure, container } = callOptions
    const middlewareInjectables = [
      ...this.application.registry.middlewares,
      ...namespace.middlewares,
      ...procedure.middlewares,
    ]
    const middlewares = await Promise.all(
      middlewareInjectables.map((p) => container.resolve(p)),
    )
    return middlewares[Symbol.iterator]()
  }

  private async resolveGuards(callOptions: ApplicationApiCallOptions) {
    const { namespace, procedure, container } = callOptions
    const injectables = [
      ...this.application.registry.guards,
      ...namespace.guards,
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
      new ApplicationApiError(ErrorCode.RequestTimeout, 'Request Timeout'),
      controller,
    )
  }

  private async handleGuards(
    callOptions: ApplicationApiCallOptions,
    callCtx: ApiCallContext,
    guards: Iterable<GuardLike>,
  ) {
    console.dir(guards)
    for (const guard of guards) {
      const result = await guard.can(callCtx)
      if (result === false) throw new ApplicationApiError(ErrorCode.Forbidden)
    }
  }

  private async handleFilters(error: any) {
    if (this.application.registry.filters.size) {
      for (const [errorType, filter] of this.application.registry.filters) {
        if (error instanceof errorType) {
          const filterLike = await this.application.container.resolve(filter)
          const handledError = await filterLike.catch(error)
          if (!handledError || !(handledError instanceof ApplicationApiError))
            continue
          return handledError
        }
      }
    }

    if (error instanceof ApplicationApiError) return error

    return new ApplicationApiError(
      ErrorCode.InternalServerError,
      'Internal Server Error',
    )
  }

  private handleInput(procedure: AnyBaseProcedure, payload: any) {
    if (procedure.contract.input instanceof NeverType === false) {
      const type = this.getType(procedure.contract.input)
      try {
        return type.decode(
          type.applyDefaults(type.parse(payload, cloneOptions)),
        )
      } catch (error) {
        throw new ApplicationApiError(
          ErrorCode.ValidationError,
          'Input validation error',
          type.errors(payload),
        )
      }
    }
  }

  private handleIterableOutput(procedure: AnyBaseProcedure, response: any) {
    if (!response[kIterableResponse])
      throw new Error('Invalid response. Use `createIterableResponse` helper')
    const iterable = response.iterable
    if (procedure.contract.output instanceof NeverType === false) {
      const type = this.getType(procedure.contract.output)
      return {
        output: type.applyDefaults(
          type.parse(type.encode(response), cloneOptions),
        ),
        iterable,
      }
    }
    return { output: undefined, iterable }
  }

  private handleOutput(procedure: AnyBaseProcedure, response: any) {
    if (procedure.contract.output instanceof NeverType === false) {
      const type = this.getType(procedure.contract.output)
      return {
        output: type.applyDefaults(
          type.parse(type.encode(response), cloneOptions),
        ),
      }
    }
    return { output: undefined }
  }

  private handleSubscriptionOutput(
    callOptions: ApplicationApiCallOptions,
    response: any,
  ) {
    throw new Error('Not implemented')
  }

  private getType(type: BaseType) {
    const compiled = this.application.registry.compiled.get(type)
    if (!compiled) throw new Error('Compiled type not found')
    return compiled
  }
}

export class ApplicationApiError extends ProtocolError {
  toString() {
    return `${this.code} ${this.message}: \n${inspect(this.data, true, 10, false)}`
  }
}

const NotFound = () =>
  new ApplicationApiError(ErrorCode.NotFound, 'Procedure not found')

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
