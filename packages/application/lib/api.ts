import { ErrorCode, StreamDataType } from '@neematajs/common'
import type {
  DownStream,
  TBaseProcedureContract,
  TDownStreamContract,
  TProcedureContract,
  TSchema,
  TSubscriptionContract,
} from '@neematajs/contract'
import type { Compiled } from '@neematajs/contract/compiler'
import { ContractGuard } from '@neematajs/contract/guards'

import { IsDownStream } from '../../contract/src/guards/streams.ts'
import type { ApplicationOptions } from './application.ts'
import { Scope } from './constants.ts'
import {
  type Container,
  type Dependencies,
  type DependencyContext,
  type Depender,
  Provider,
} from './container.ts'
import type { Logger } from './logger.ts'
import type { Registry } from './registry.ts'
import type { Service } from './service.ts'
import {
  BinaryStreamResponse,
  EncodedStreamResponse,
  StreamResponse,
} from './streams.ts'
import { type Subscription, SubscriptionResponse } from './subscription.ts'
import type { BaseTransport, BaseTransportConnection } from './transport.ts'
import type {
  AnyGuard,
  AnyMiddleware,
  AnyProcedure,
  AnyTransportClass,
  Async,
  ConnectionFn,
  ConnectionProvider,
  DecodeInputSchema,
  ErrorClass,
  FilterFn,
  GuardFn,
  MiddlewareContext,
  MiddlewareFn,
} from './types.ts'
import { merge, withTimeout } from './utils/functions.ts'

export type ProcedureHandlerType<
  ProcedureContract extends TBaseProcedureContract,
  ProcedureTransports extends AnyTransportClass[],
  Deps extends Dependencies,
> = (
  ctx: DependencyContext<
    ApplyProcedureTransport<ProcedureContract, ProcedureTransports, Deps>
  >,
  data: ProcedureContract['input']['static'] extends never
    ? never
    : DecodeInputSchema<ProcedureContract['input']>,
) => Async<
  ProcedureContract extends TProcedureContract
    ? ProcedureContract['output']['static'] extends never
      ? void
      : ProcedureContract['output'] extends TDownStreamContract<any, any, any>
        ? StreamResponse<
            ProcedureContract['output']['static']['__payload'],
            ProcedureContract['output']['static']['__type'] extends StreamDataType.Binary
              ? string | Buffer | ArrayBuffer
              : ProcedureContract['output']['static']['__chunk'],
            ProcedureContract['output']['static']['__payload']
          >
        : ProcedureContract['output']['static']
    : ProcedureContract extends TSubscriptionContract
      ? ProcedureContract['output']['static'] extends never
        ? SubscriptionResponse<any, never, never>
        : SubscriptionResponse<
            any,
            ProcedureContract['output']['static'],
            ProcedureContract['output']['static']
          >
      : never
>

export type ApplyProcedureTransport<
  C extends TBaseProcedureContract,
  T extends AnyTransportClass[],
  D extends Dependencies,
> = {
  [K in keyof D]: D[K] extends typeof Procedure.connection
    ? Provider<
        T extends []
          ? BaseTransportConnection
          : BaseTransportConnection & InstanceType<T[number]>['_']['connection']
      >
    : D[K] extends typeof Procedure.response
      ? Provider<
          C['output']['static'] extends DownStream<any, infer P, infer C>
            ? StreamResponse<P, C, P extends never ? any : unknown>
            : undefined
        >
      : D[K]
}

export class Procedure<
  ProcedureContract extends TBaseProcedureContract = TBaseProcedureContract,
  ProcedureDeps extends Dependencies = {},
  ProcedureTransports extends AnyTransportClass[] = [],
> implements Depender<ProcedureDeps>
{
  static connection = new Provider<BaseTransport['_']['connection']>()
    .withScope(Scope.Connection)
    .withDescription('RPC connection')

  static signal = new Provider<AbortSignal>()
    .withScope(Scope.Call)
    .withDescription('RPC abort signal')

  // static options = new Provider<{
  //   serviceContract: TServiceContract
  //   procedureContract: TProcedureContract
  //   procedureName: string
  // }>()
  //   .withScope(Scope.Global)
  //   .withDescription('Current procedure options')

  static response = new Provider<StreamResponse<any, any> | undefined>()
    .withScope(Scope.Call)
    .withDescription('Current procedure stream response')

  static $withTransports<T extends AnyTransportClass[]>() {
    return <
      Contract extends TBaseProcedureContract<
        any,
        any,
        string,
        string,
        { [K in InstanceType<T[number]>['_']['type']]: true }
      >,
    >(
      contract: Contract,
    ) => new Procedure<Contract, {}, T>(contract)
  }

  _!: {
    transports: ProcedureTransports
  }

  handler: ProcedureHandlerType<
    ProcedureContract,
    ProcedureTransports,
    ProcedureDeps
  >
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
    for (const [key, provider] of Object.entries(dependencies)) {
      if (provider === Procedure.response) {
        // @ts-expect-error
        dependencies[key] = Procedure.response.withFactory(() => {
          if (IsDownStream(this.contract.output)) {
            return this.contract.output.dataType === StreamDataType.Encoded
              ? new EncodedStreamResponse()
              : new BinaryStreamResponse(this.contract.output.contentType!)
          }
          return undefined
        })
      }
    }
    this.dependencies = merge(this.dependencies, dependencies)
    return this as unknown as Procedure<
      ProcedureContract,
      ProcedureDeps & Deps,
      ProcedureTransports
    >
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
}

export type ProcedureCallOptions = {
  service: Service
  procedure: AnyProcedure
  transport: BaseTransport
  connection: BaseTransportConnection
  payload: any
  container: Container
}

const NotFound = () => new ApiError(ErrorCode.NotFound, 'Procedure not found')

export class Api {
  connectionProvider?: ConnectionProvider<any, any>
  connectionFn?: ConnectionFn<any, any>

  constructor(
    private readonly application: {
      container: Container
      registry: Registry
      logger: Logger
      transports: Set<BaseTransport>
    },
    private readonly options: ApplicationOptions['api'],
  ) {}

  find(serviceName: string, procedureName: string, transport: BaseTransport) {
    const service = this.application.registry.services.get(serviceName)
    if (service) {
      if (transport.type in service.contract.transports) {
        const procedure = service.procedures.get(procedureName)
        if (procedure) return { service, procedure }
      }
    }

    throw NotFound()
  }

  async call(callOptions: ProcedureCallOptions) {
    const { payload, container, connection } = callOptions

    container.provide(Procedure.connection, connection)

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
      if (transport.type === transportType) return
    }

    throw NotFound()
  }

  private handleTimeout(response: any, timeout?: number) {
    const applyTimeout = timeout && response instanceof Promise
    const error = new ApiError(ErrorCode.RequestTimeout, 'Request Timeout')
    return applyTimeout ? withTimeout(response, timeout, error) : response
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
    } else if (ContractGuard.IsDownStream(procedure.contract.output)) {
      if (response instanceof StreamResponse === false) {
        throw new Error(
          'Invalid response: should be instance of StreamResponse',
        )
      }

      if (!ContractGuard.IsNever(procedure.contract.output.payload)) {
        const result = this.handleSchema(
          procedure.contract.output,
          'encode',
          response.payload,
        )
        if (!result.success) {
          throw new Error('Failed to encode stream payload', {
            cause: result.error,
          })
        }
        response.withPayload(result.value)
        return response
      }
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
    return this.code + super.message
  }

  toString() {
    return `${this.code} ${this.message}`
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      data: this.data,
    }
  }
}

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
