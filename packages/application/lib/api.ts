import { ErrorCode } from '@nmtjs/common'
import type {
  TBaseProcedureContract,
  TProcedureContract,
  TSubscriptionContract,
} from '@nmtjs/contract'
import { type BaseType, NeverType, type t } from '@nmtjs/type'
import type { Compiled } from '@nmtjs/type/compiler'

import type { ApplicationOptions } from './application.ts'
import type { Connection } from './connection.ts'
import type { Scope } from './constants.ts'
import {
  type Container,
  type Dependant,
  type Dependencies,
  type DependencyContext,
  Injectable,
} from './container.ts'
import { injectables } from './injectables.ts'
import type { Logger } from './logger.ts'
import type { Registry } from './registry.ts'
import type { AnyService, ServiceLike } from './service.ts'
import { SubscriptionResponse } from './subscription.ts'
import type { Async, ErrorClass, InputType, OutputType } from './types.ts'
import { merge, withTimeout } from './utils/functions.ts'

export type ProcedureHandlerType<
  ProcedureContract extends TBaseProcedureContract,
  Deps extends Dependencies,
> = (
  ctx: DependencyContext<Deps>,
  data: ProcedureContract['input'] extends NeverType
    ? never
    : InputType<t.infer.decoded<ProcedureContract['input']>>,
) => Async<
  ProcedureContract extends TProcedureContract
    ? ProcedureContract['output'] extends NeverType
      ? void
      : OutputType<t.infer.decoded<ProcedureContract['output']>>
    : ProcedureContract extends TSubscriptionContract
      ? ProcedureContract['output'] extends NeverType
        ? SubscriptionResponse<any, never, never>
        : SubscriptionResponse<
            any,
            OutputType<t.infer.decoded<ProcedureContract['output']>>,
            OutputType<t.infer.decoded<ProcedureContract['output']>>
          >
      : never
>

export interface ProcedureLike<
  ProcedureContract extends TBaseProcedureContract = TBaseProcedureContract,
  ProcedureDeps extends Dependencies = Dependencies,
> extends Dependant<ProcedureDeps> {
  contract: ProcedureContract
  handler: ProcedureHandlerType<ProcedureContract, ProcedureDeps>
  metadata: Map<MetadataKey<any, any>, any>
  dependencies: ProcedureDeps
  guards: Set<AnyGuard>
  middlewares: Set<AnyMiddleware>
}

export interface FilterLike<T extends ErrorClass = ErrorClass> {
  catch(error: InstanceType<T>): Async<Error>
}

export type ExecuteContext = Readonly<{
  connection: Connection
  container: Container
  procedure: ProcedureLike
  service: ServiceLike
}>

export interface GuardLike {
  can(context: ExecuteContext): Async<boolean>
}

export type MiddlewareNext = (payload?: any) => any

export interface MiddlewareLike {
  handle(context: ExecuteContext, next: MiddlewareNext, payload: any): any
}

export type AnyGuard = Guard<any>
export class Guard<Deps extends Dependencies = {}> extends Injectable<
  GuardLike,
  Deps,
  Scope.Global
> {}

export type AnyMiddleware = Middleware<any>
export class Middleware<Deps extends Dependencies = {}> extends Injectable<
  MiddlewareLike,
  Deps,
  Scope.Global
> {}

export type AnyFilter<Error extends ErrorClass = ErrorClass> = Filter<
  Error,
  any
>
export class Filter<
  Error extends ErrorClass = ErrorClass,
  Deps extends Dependencies = {},
> extends Injectable<FilterLike<Error>, Deps, Scope.Global> {}

type A = TSubscriptionContract | TProcedureContract

export type AnyProcedure<Contract extends A = any> = Procedure<
  Contract,
  Dependencies,
  any
>

export class Procedure<
  ProcedureContract extends A = A,
  ProcedureDeps extends Dependencies = {},
  ProcedureHandler extends ProcedureHandlerType<
    ProcedureContract,
    ProcedureDeps
  > = ProcedureHandlerType<ProcedureContract, ProcedureDeps>,
> implements ProcedureLike<ProcedureContract, ProcedureDeps>
{
  handler: ProcedureHandler
  dependencies: ProcedureDeps = {} as ProcedureDeps
  readonly metadata: Map<MetadataKey<any, any>, any> = new Map()
  readonly middlewares = new Set<AnyMiddleware>()
  readonly guards = new Set<AnyGuard>()

  constructor(public readonly contract: ProcedureContract) {
    this.handler = notImplemented(contract) as unknown as ProcedureHandler
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
    return this
  }
}

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

  private handleInput(procedure: Procedure, payload: any) {
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

  private handleOutput(procedure: Procedure, response: any) {
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

const notImplemented = (contract: TBaseProcedureContract) => () => {
  throw new Error(
    `Procedure [${contract.serviceName}/${contract.name}] handler is not implemented`,
  )
}
