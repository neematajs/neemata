import { ErrorCode } from '@nmtjs/common'
import type {
  Decoded,
  TBaseProcedureContract,
  TProcedureContract,
  TSchema,
  TSubscriptionContract,
} from '@nmtjs/contract'
import type { Compiled } from '@nmtjs/contract/compiler'
import { ContractGuard } from '@nmtjs/contract/guards'

import type { ApplicationOptions } from './application.ts'
import type { Connection } from './connection.ts'
import {
  type Container,
  type Dependencies,
  type DependencyContext,
  type Depender,
  Provider,
} from './container.ts'
import type { Logger } from './logger.ts'
import { providers } from './providers.ts'
import type { Registry } from './registry.ts'
import type { Service } from './service.ts'
import { SubscriptionResponse } from './subscription.ts'
import type {
  AnyGuard,
  AnyMiddleware,
  AnyProcedure,
  Async,
  ConnectionFn,
  ConnectionProvider,
  ErrorClass,
  FilterFn,
  GuardFn,
  InputType,
  MiddlewareContext,
  MiddlewareFn,
  OutputType,
} from './types.ts'
import { merge, withTimeout } from './utils/functions.ts'

export type ProcedureHandlerType<
  ProcedureContract extends TBaseProcedureContract,
  Deps extends Dependencies,
> = (
  ctx: DependencyContext<Deps>,
  data: Decoded<ProcedureContract['input']> extends never
    ? never
    : InputType<Decoded<ProcedureContract['input']>>,
) => Async<
  ProcedureContract extends TProcedureContract
    ? Decoded<ProcedureContract['output']> extends never
      ? void
      : OutputType<Decoded<ProcedureContract['output']>>
    : ProcedureContract extends TSubscriptionContract
      ? Decoded<ProcedureContract['output']> extends never
        ? SubscriptionResponse<any, never, never>
        : SubscriptionResponse<
            any,
            OutputType<Decoded<ProcedureContract['output']>>,
            OutputType<Decoded<ProcedureContract['output']>>
          >
      : never
>

export class Procedure<
  ProcedureContract extends TBaseProcedureContract = TBaseProcedureContract,
  ProcedureDeps extends Dependencies = {},
> implements Depender<ProcedureDeps>
{
  handler: ProcedureHandlerType<ProcedureContract, ProcedureDeps>
  metadata: Map<MetadataKey<any, any>, any> = new Map()
  dependencies: ProcedureDeps = {} as ProcedureDeps
  guards = new Set<AnyGuard>()
  middlewares = new Set<AnyMiddleware>()

  constructor(public readonly contract: ProcedureContract) {
    this.handler = () => {
      throw new Error(
        `Procedure handler [${contract.serviceName}/${contract.name}] is not defined`,
      )
    }
  }

  withDependencies<Deps extends Dependencies>(dependencies: Deps) {
    this.dependencies = merge(this.dependencies, dependencies)
    return this as unknown as Procedure<ProcedureContract, ProcedureDeps & Deps>
  }

  withHandler(handler: this['handler']) {
    this.handler = handler
    return this
  }

  withGuards(...guards: AnyGuard[]) {
    for (const guard of guards) this.guards.add(guard)
    return this
  }

  withMiddlewares(...middlewares: AnyMiddleware[]) {
    for (const middleware of middlewares) this.middlewares.add(middleware)
    return this
  }

  withMetadata<T extends MetadataKey<any, any>>(key: T, value: T['type']) {
    this.metadata.set(key, value)
  }
}

export type ProcedureCallOptions = {
  connection: Connection
  service: Service
  procedure: AnyProcedure
  container: Container
  payload: any
  signal: AbortSignal
  transport: string
}

export class Api {
  connectionProvider?: ConnectionProvider<any, any>
  connectionFn?: ConnectionFn<any, any>

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

  async call(callOptions: ProcedureCallOptions) {
    const { payload, container, connection, signal } = callOptions

    container.provide(providers.connection, connection)
    container.provide(providers.signal, signal)

    try {
      this.handleTransport(callOptions)
      const handler = await this.createProcedureHandler(callOptions)
      return await handler(payload)
    } catch (error) {
      throw await this.handleFilters(error)
    }
  }

  private async createProcedureHandler(callOptions: ProcedureCallOptions) {
    const { connection, procedure, container, service } = callOptions

    const middlewareCtx: MiddlewareContext = {
      connection,
      container,
      service,
      procedure,
    }

    const middlewares = await this.resolveMiddlewares(callOptions)

    const timeout =
      service.contract.timeout ||
      procedure.contract.timeout ||
      this.options.timeout

    const handleProcedure = async (payload: any) => {
      const middleware = middlewares?.next().value
      if (middleware) {
        const next = (newPayload = payload) => handleProcedure(newPayload)
        return middleware(middlewareCtx, next, payload)
      } else {
        await this.handleGuards(callOptions)
        const { dependencies } = procedure
        const context = await container.createContext(dependencies)
        const input = this.handleInput(procedure, payload)
        const result = await this.handleTimeout(
          procedure.handler(context, input),
          timeout,
        )

        const output = this.handleOutput(procedure, result)

        return output
      }
    }

    return handleProcedure
  }

  private async resolveMiddlewares(callOptions: ProcedureCallOptions) {
    const { service, procedure, container } = callOptions
    const middlewareProviders = [
      ...service.middlewares,
      ...procedure.middlewares,
    ]
    const middlewares = await Promise.all(
      middlewareProviders.map((p) => container.resolve(p)),
    )
    return middlewares[Symbol.iterator]()
  }

  private handleTransport({ service, transport }: ProcedureCallOptions) {
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

  private async handleGuards(callOptions: ProcedureCallOptions) {
    const { service, procedure, container, connection } = callOptions
    const providers = [...service.guards, ...procedure.guards]
    const guards = await Promise.all(providers.map((p) => container.resolve(p)))
    const guardOptions = Object.freeze({ connection })
    for (const guard of guards) {
      const result = await guard(guardOptions)
      if (result === false) throw new ApiError(ErrorCode.Forbidden)
    }
  }

  private async handleFilters(error: any) {
    if (this.application.registry.filters.size) {
      for (const [errorType, filter] of this.application.registry.filters) {
        if (error instanceof errorType) {
          const filterFn = await this.application.container.resolve(filter)
          const handledError = await filterFn(error)
          if (!handledError || !(handledError instanceof ApiError)) continue
          return handledError
        }
      }
    }
    if (error instanceof ApiError) return error

    // FIXME: this shouldn't be here
    if (process.env.TEST) return error

    const logError = new Error('Unhandled error', { cause: error })
    this.application.logger.error(logError)
    return new ApiError(ErrorCode.InternalServerError, 'Internal Server Error')
  }

  private handleInput(procedure: Procedure, payload: any) {
    if (!ContractGuard.IsNever(procedure.contract.input)) {
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

  private handleOutput(procedure: Procedure, response: any) {
    if (ContractGuard.IsSubscription(procedure.contract)) {
      if (response instanceof SubscriptionResponse === false) {
        throw new Error(
          'Invalid response: should be instance of SubscriptionResponse',
        )
      }

      if (!ContractGuard.IsNever(procedure.contract.output)) {
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
    } else if (!ContractGuard.IsNever(procedure.contract.output)) {
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
    schema: TSchema,
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

export type MetadataKey<V = any, T = any> = { key: V; type: T }

export const MetadataKey = <T>(key: string | object) =>
  ({ key }) as MetadataKey<typeof key, T>

export const getProcedureMetadata = <
  T extends MetadataKey,
  D extends T['type'] | undefined = undefined,
>(
  procedure: Procedure,
  key: T,
  defaultValue?: D,
): D extends undefined ? T['type'] | undefined : T['type'] => {
  return procedure.metadata.get(key) ?? defaultValue
}

const NotFound = () => new ApiError(ErrorCode.NotFound, 'Procedure not found')

export class Guard<Deps extends Dependencies = {}> extends Provider<
  GuardFn,
  Deps
> {}

export class Middleware<Deps extends Dependencies = {}> extends Provider<
  MiddlewareFn,
  Deps
> {}

export class Filter<Error extends ErrorClass = ErrorClass> extends Provider<
  FilterFn<Error>
> {}
