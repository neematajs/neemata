import assert from 'node:assert'
import {
  ApiError,
  type CallTypeProvider,
  ErrorCode,
  type TypeProvider,
} from '@neematajs/common'
import type {
  TProcedureContract,
  TServiceContract,
  TSubscriptionContract,
} from '@neematajs/contract'
import type { ApplicationOptions } from './application'
import { Scope } from './constants'
import {
  type Container,
  type Dependencies,
  type DependencyContext,
  type Depender,
  Provider,
} from './container'
import type { Logger } from './logger'
import type { Registry } from './registry'
import type { Service } from './service'
import type { Subscription } from './subscription'
import type { BaseTransport, BaseTransportConnection } from './transport'
import type {
  AnyGuard,
  AnyMiddleware,
  AnyProcedure,
  Async,
  ClassConstructor,
  ConnectionFn,
  ConnectionProvider,
  ErrorClass,
  FilterFn,
  GuardFn,
  MiddlewareContext,
  MiddlewareFn,
} from './types'
import { merge, withTimeout } from './utils/functions'

export type AnyTransportClass = ClassConstructor<
  BaseTransport<string, BaseTransportConnection, any>
>

export type ResolvedProcedureContext<Deps extends Dependencies> =
  DependencyContext<Deps>

export type ProcedureOptionType<ProcedureDeps extends Dependencies, T> =
  | T
  | ((ctx: ResolvedProcedureContext<ProcedureDeps>) => Async<T>)

export type ProcedureHandlerType<
  ProcedureDeps extends Dependencies,
  ProcedureInput,
  ProcedureOutput,
  ProcedureInputTypeProvider extends TypeProvider,
  ProcedureOutputTypeProvider extends TypeProvider,
  Response = ProcedureOutput extends never
    ? any
    : CallTypeProvider<ProcedureOutputTypeProvider, ProcedureOutput>,
> = (
  ctx: ResolvedProcedureContext<ProcedureDeps>,
  data: CallTypeProvider<ProcedureInputTypeProvider, ProcedureInput>,
) => Response

export type ProcedureHandler<
  ServiceContract extends TServiceContract,
  ProcedureName extends Extract<keyof ServiceContract['procedures'], string>,
  Deps extends Dependencies,
  ProcedureContract extends
    TProcedureContract = ServiceContract['procedures'][ProcedureName],
> = (
  ctx: ResolvedProcedureContext<Deps>,
  data: null extends ProcedureContract['static']['input']
    ? unknown
    : ProcedureContract['static']['input'],
) => ProcedureContract['static']['output'] extends never
  ? Async<void>
  : ProcedureContract['output'] extends TSubscriptionContract
    ? Async<Subscription<ProcedureContract['output']>>
    : Async<ProcedureContract['static']['output']>

export type ApplyProcedureTransport<
  C extends TServiceContract,
  P extends keyof C['procedures'],
  T extends AnyTransportClass[],
  D extends Dependencies,
> = {
  [K in keyof D]: D[K] extends typeof Procedure.connection
    ? Provider<
        T extends []
          ? BaseTransportConnection
          : BaseTransportConnection & InstanceType<T[number]>['_']['connection']
      >
    : D[K] extends typeof Procedure.options
      ? Provider<{
          serviceContract: C
          procedureContract: C['procedures'][P]
          procedureName: P
        }>
      : D[K]
}

export class Procedure<
  Contract extends TServiceContract = TServiceContract,
  ProcedureName extends Extract<keyof Contract['procedures'], string> = Extract<
    keyof Contract['procedures'],
    string
  >,
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

  static options = new Provider<{
    serviceContract: TServiceContract
    procedureContract: TProcedureContract
    procedureName: string
  }>()
    .withScope(Scope.Global)
    .withDescription('Current procedure options')

  static $withTransports<T extends AnyTransportClass[]>() {
    return <
      Contract extends TServiceContract<
        string,
        { [K in InstanceType<T[number]>['_']['type']]: true }
      >,
      ProcedureName extends Extract<keyof Contract['procedures'], string>,
    >(
      serviceContract: Contract,
      procedureName: ProcedureName,
    ) =>
      new Procedure<Contract, ProcedureName, {}, T>(
        serviceContract,
        procedureName,
      )
  }

  _!: {
    transports: ProcedureTransports
  }

  handler: ProcedureHandler<Contract, ProcedureName, ProcedureDeps>
  dependencies: ProcedureDeps = {} as ProcedureDeps
  guards = new Set<AnyGuard>()
  middlewares = new Set<AnyMiddleware>()

  constructor(
    public readonly serviceContract: Contract,
    public readonly procedureName: ProcedureName,
  ) {
    assert(procedureName in serviceContract.procedures, 'Procedure not found')

    this.handler = () => {
      throw new Error(
        `Procedure handler [${serviceContract.name}/${procedureName as string}] is not defined`,
      )
    }
  }

  withDependencies<Deps extends Dependencies>(dependencies: Deps) {
    for (const [key, provider] of Object.entries(dependencies)) {
      if (provider === Procedure.options) {
        // @ts-expect-error
        dependencies[key] = Procedure.options.withValue({
          serviceContract: this.serviceContract,
          procedureContract: this.contract,
          procedureName: this.procedureName,
        })
      }
    }
    this.dependencies = merge(this.dependencies, dependencies)
    return this as unknown as Procedure<
      Contract,
      ProcedureName,
      ProcedureDeps &
        ApplyProcedureTransport<
          Contract,
          ProcedureName,
          ProcedureTransports,
          Deps
        >,
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

  get contract() {
    return this.serviceContract.procedures[
      this.procedureName
    ] as Contract['procedures'][ProcedureName]
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

        const input = this.handleSchema(
          procedure,
          'input',
          'decode',
          payload,
          context,
        )

        const result = await this.handleTimeout(
          procedure.handler(context, input),
          timeout,
        )

        const output = this.handleSchema(
          procedure,
          'output',
          'encode',
          result,
          context,
        )

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
    const logError = new Error('Unhandled error', { cause: error })
    this.application.logger.error(logError)
    return new ApiError(ErrorCode.InternalServerError, 'Internal Server Error')
  }

  private handleSchema(
    procedure: Procedure,
    type: 'input' | 'output',
    method: 'decode' | 'encode',
    payload: any,
    context: any,
  ) {
    const compiler = this.application.registry.schemas.get(
      procedure.contract[type],
    )
    if (!compiler) return payload
    return compiler[method](payload)
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
