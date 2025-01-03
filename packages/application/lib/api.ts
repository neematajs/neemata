import { ErrorCode } from '@nmtjs/common'
import { type BaseType, NeverType } from '@nmtjs/type'

import type { ApplicationOptions } from './application.ts'
import { builtin } from './common.ts'
import type { Connection } from './connection.ts'
import { Scope } from './constants.ts'
import type { Container } from './container.ts'
import type { Logger } from './logger.ts'
import type { AnyBaseProcedure, MiddlewareLike } from './procedure.ts'
import type { Registry } from './registry.ts'
import type { AnyService } from './service.ts'
import { SubscriptionResponse } from './subscription.ts'
import type { CallContext } from './types.ts'
import { withTimeout } from './utils/functions.ts'

export type ApiCallOptions = {
  connection: Connection
  service: AnyService
  procedure: AnyBaseProcedure
  container: Container
  payload: any
  signal: AbortSignal
  transport: string
}

export class Api {
  constructor(
    private readonly application: {
      container: Container
      registry: Registry
      logger: Logger
    },
    private readonly options: ApplicationOptions['api'],
  ) {}

  find(serviceName: string, procedureName: string, transport: string) {
    const service = this.application.registry.services.get(serviceName)
    if (service) {
      if (service.contract.transports[transport]) {
        const procedure = service.procedures.get(procedureName)
        if (procedure) return { service, procedure }
      }
    }

    throw NotFound()
  }

  async call(callOptions: ApiCallOptions) {
    const { payload, container, signal, connection } = callOptions

    if (container.scope !== Scope.Call)
      throw new Error('Invalid container scope, expected to be Scope.Call')

    container.provide(builtin.callSignal, signal)
    container.provide(builtin.connection, connection)

    try {
      this.handleTransport(callOptions)
      const handler = await this.createProcedureHandler(callOptions)
      return await handler(payload)
    } catch (error) {
      throw await this.handleFilters(error)
    }
  }

  private async createProcedureHandler(callOptions: ApiCallOptions) {
    const { connection, procedure, container, service } = callOptions

    const execCtx: CallContext = Object.freeze({
      connection,
      container,
      service,
      procedure,
    })

    const middlewares = await this.resolveMiddlewares(callOptions)

    const timeout =
      procedure.contract.timeout ||
      service.contract.timeout ||
      this.options.timeout

    const handleProcedure = async (payload: any) => {
      const middleware = middlewares.next().value as MiddlewareLike | undefined
      if (middleware) {
        const next = (newPayload = payload) => handleProcedure(newPayload)
        return middleware.handle(execCtx, next, payload)
      } else {
        await this.handleGuards(callOptions, execCtx)
        const { dependencies } = procedure
        const context = await container.createContext(dependencies)
        const input = this.handleInput(procedure, payload)
        const result = await this.handleTimeout(
          procedure.handler(context, input),
          timeout,
        )
        return this.handleOutput(procedure, result)
      }
    }

    return handleProcedure
  }

  private async resolveMiddlewares(callOptions: ApiCallOptions) {
    const { service, procedure, container } = callOptions
    const middlewareInjectables = [
      ...service.middlewares,
      ...procedure.middlewares,
    ]
    const middlewares = await Promise.all(
      middlewareInjectables.map((p) => container.resolve(p)),
    )
    return middlewares[Symbol.iterator]()
  }

  private handleTransport({ service, transport }: ApiCallOptions) {
    if (service.contract.transports[transport] !== true) {
      throw NotFound()
    }
  }

  private handleTimeout(response: any, timeout?: number) {
    const applyTimeout = timeout && timeout > 0 && response instanceof Promise
    return applyTimeout
      ? withTimeout(
          response,
          timeout,
          new ApiError(ErrorCode.RequestTimeout, 'Request Timeout'),
        )
      : response
  }

  private async handleGuards(
    callOptions: ApiCallOptions,
    callCtx: CallContext,
  ) {
    const { service, procedure, container } = callOptions
    const injectables = [...service.guards, ...procedure.guards]
    const guards = await Promise.all(
      injectables.map((p) => container.resolve(p)),
    )
    for (const guard of guards) {
      const result = await guard.can(callCtx)
      if (result === false) throw new ApiError(ErrorCode.Forbidden)
    }
  }

  private async handleFilters(error: any) {
    if (this.application.registry.filters.size) {
      for (const [errorType, filter] of this.application.registry.filters) {
        if (error instanceof errorType) {
          const filterLike = await this.application.container.resolve(filter)
          const handledError = await filterLike.catch(error)
          if (!handledError || !(handledError instanceof ApiError)) continue
          return handledError
        }
      }
    }

    if (error instanceof ApiError) return error

    const logError = new Error('Unhandled error', { cause: error })
    this.application.logger.error(logError)
    return new ApiError(ErrorCode.InternalServerError, 'Internal Server Error')
  }

  private handleInput(procedure: AnyBaseProcedure, payload: any) {
    if (procedure.contract.input instanceof NeverType === false) {
      const schema = this.getSchema(procedure.contract.input)
      const prepared = schema.parse(payload)

      if (!schema.check(prepared)) {
        throw new ApiError(
          ErrorCode.ValidationError,
          'Invalid input',
          Array.from(schema.errors(prepared)),
        )
      }

      return schema.decode(prepared)
    }
  }

  private handleOutput(procedure: AnyBaseProcedure, response: any) {
    if (procedure.contract.type === 'neemata:subscription') {
      if (response instanceof SubscriptionResponse === false) {
        throw new Error(
          'Invalid response: should be instance of SubscriptionResponse',
        )
      }

      if (procedure.contract.output instanceof NeverType === false) {
        const schema = this.getSchema(procedure.contract.output)
        const prepared = schema.parse(response)
        const result = schema.encodeSafe(prepared)
        if (result.success) return response.withPayload(result.value)
        throw new Error('Failed to encode response', { cause: result.error })
      }

      return response
    } else if (procedure.contract.output instanceof NeverType === false) {
      const schema = this.getSchema(procedure.contract.output)
      const prepared = schema.parse(response)
      const result = schema.encodeSafe(prepared)
      if (result.success) return result.value
      throw new Error('Failed to encode response', { cause: result.error })
    }
  }

  private getSchema(schema: BaseType) {
    const compiled = this.application.registry.schemas.get(schema)
    if (!compiled) throw new Error('Compiled schema not found')
    return compiled
  }
}

export class ApiError extends Error {
  code: string
  data?: any

  constructor(code: string, message?: string, data?: any) {
    super(message)
    this.code = code
    this.data = data
  }

  get message() {
    return `${this.code} ${super.message}`
  }

  toString() {
    return `${this.code} ${this.message}: \n${JSON.stringify(this.data, null, 2)}`
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      data: this.data,
    }
  }
}

const NotFound = () => new ApiError(ErrorCode.NotFound, 'Procedure not found')
