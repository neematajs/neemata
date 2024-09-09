import { ErrorCode } from '@nmtjs/common'
import { type BaseType, NeverType } from '@nmtjs/type'
import type { Compiled } from '@nmtjs/type/compiler'

import type { ApplicationOptions } from './application.ts'
import { injectables } from './common.ts'
import type { Connection } from './connection.ts'
import type { Container } from './container.ts'
import type { Logger } from './logger.ts'
import type { AnyProcedure, MiddlewareLike } from './procedure.ts'
import type { Registry } from './registry.ts'
import type { AnyService } from './service.ts'
import { SubscriptionResponse } from './subscription.ts'
import type { ExecuteContext } from './types.ts'
import { withTimeout } from './utils/functions.ts'

export type ApiCallOptions = {
  connection: Connection
  service: AnyService
  procedure: AnyProcedure
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
    const { payload, container, connection, signal } = callOptions

    container.provide(injectables.connection, connection)
    container.provide(injectables.callSignal, signal)

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

    const execCtx: ExecuteContext = Object.freeze({
      connection,
      container,
      service,
      procedure,
    })

    const middlewares = await this.resolveMiddlewares(callOptions)

    const timeout =
      service.contract.timeout ||
      procedure.contract.timeout ||
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
    for (const transportType in service.contract.transports) {
      if (transport === transportType) return
    }

    throw NotFound()
  }

  private handleTimeout(response: any, timeout?: number) {
    const applyTimeout = timeout && response instanceof Promise
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
    execCtx: ExecuteContext,
  ) {
    const { service, procedure, container, connection } = callOptions
    const injectables = [...service.guards, ...procedure.guards]
    const guards = await Promise.all(
      injectables.map((p) => container.resolve(p)),
    )
    for (const guard of guards) {
      const result = await guard.can(execCtx)
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

  private handleInput(procedure: AnyProcedure, payload: any) {
    if (procedure.contract.input instanceof NeverType === false) {
      const result = this.handleSchema(
        procedure.contract.input,
        'decode',
        payload,
      )

      if (result.success) return result.value

      throw new ApiError(
        ErrorCode.ValidationError,
        'Invalid input',
        result.error,
      )
    }
  }

  private handleOutput(procedure: AnyProcedure, response: any) {
    if (procedure.contract.type === 'neemata:subscription') {
      if (response instanceof SubscriptionResponse === false) {
        throw new Error(
          'Invalid response: should be instance of SubscriptionResponse',
        )
      }

      if (procedure.contract.output instanceof NeverType === false) {
        const result = this.handleSchema(
          procedure.contract.output,
          'encode',
          response.payload,
        )
        if (!result.success) {
          throw new Error('Failed to encode subscription payload', {
            cause: result.error,
          })
        }
        response.withPayload(result.value)
      }

      return response
    } else if (procedure.contract.output instanceof NeverType === false) {
      const result = this.handleSchema(
        procedure.contract.output,
        'encode',
        response,
      )
      if (!result.success) {
        throw new Error('Failed to encode response', { cause: result.error })
      }
      return result.value
    }
  }

  private handleSchema(
    schema: BaseType,
    method: 'decode' | 'encode',
    payload: any,
    context?: any,
  ): ReturnType<Compiled['decode' | 'encode']> {
    const compiled = this.application.registry.schemas.get(schema)
    if (!compiled) throw new Error('Compiled schema not found')
    return compiled[method](payload)
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
