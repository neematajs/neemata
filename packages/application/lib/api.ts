import {
  ApiError,
  type CallTypeProvider,
  ErrorCode,
  type TypeProvider,
} from '@neematajs/common'
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
import type { BaseTransport, BaseTransportConnection } from './transport'
import type {
  AnyGuard,
  AnyMiddleware,
  AnyProcedure,
  ApiPath,
  Async,
  ConnectionFn,
  ConnectionProvider,
  ErrorClass,
  Extra,
  FilterFn,
  GuardFn,
  MiddlewareContext,
  MiddlewareFn,
} from './types'
import { merge, withTimeout } from './utils/functions'

export type AnyTransportClass = new (...args: any[]) => BaseTransport<any>

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

export type ApplyProcedureTransport<
  T extends AnyTransportClass[],
  D extends Dependencies,
> = {
  [K in keyof D]: D[K] extends typeof Procedure.connection
    ? Provider<
        BaseTransportConnection & InstanceType<T[number]>['_']['connection']
      >
    : D[K]
}

export class Procedure<
  ProcedureDeps extends Dependencies = {},
  ProcedureTransports extends AnyTransportClass[] = [],
  ProcedureInput = unknown,
  ProcedureOutput = unknown,
  ProcedureInputTypeProvider extends TypeProvider = TypeProvider,
  ProcedureOutputTypeProvider extends TypeProvider = TypeProvider,
  ProcedureHandler extends ProcedureHandlerType<
    ProcedureDeps,
    ProcedureInput,
    ProcedureOutput,
    ProcedureInputTypeProvider,
    ProcedureOutputTypeProvider
  > = ProcedureHandlerType<
    ProcedureDeps,
    ProcedureInput,
    ProcedureOutput,
    ProcedureInputTypeProvider,
    ProcedureOutputTypeProvider
  >,
> implements Depender<ProcedureDeps>
{
  static override<T>(
    newProcedure: T,
    original: any,
    overrides: { [K in keyof Procedure]?: any } = {},
  ): T {
    // @ts-expect-error
    Object.assign(newProcedure, original, overrides)
    return newProcedure
  }

  static connection = new Provider<BaseTransport['_']['connection']>()
    .withScope(Scope.Connection)
    .withDescription('RPC connection')

  static signal = new Provider<AbortSignal>()
    .withScope(Scope.Call)
    .withDescription('RPC abort signal')

  _!: {
    input: ProcedureInput
    output: ProcedureOutput
    inputTypeProvider: ProcedureInputTypeProvider
    outputTypeProvider: ProcedureOutputTypeProvider
    middlewares: AnyMiddleware[]
    guards: AnyGuard[]
    options: Record<string | symbol | number, any>
    timeout: number
    transports: ProcedureTransports
  }

  readonly handler!: ProcedureHandler
  readonly timeout!: this['_']['timeout']
  readonly dependencies: ProcedureDeps = {} as ProcedureDeps
  readonly transports = new Set<AnyTransportClass>()
  readonly input!: this['_']['input']
  readonly output!: this['_']['output']
  readonly parsers: { input?: BaseParser; output?: BaseParser } = {}
  readonly options: Record<string | symbol | number, any> = {}
  readonly guards: this['_']['guards'] = []
  readonly middlewares: this['_']['middlewares'] = []

  withTransport<T extends AnyTransportClass>(transport: T) {
    const procedure = new Procedure<
      ProcedureDeps,
      [...ProcedureTransports, T],
      ProcedureInput,
      ProcedureOutput,
      ProcedureInputTypeProvider,
      ProcedureOutputTypeProvider,
      ProcedureHandler
    >()
    const transports = new Set(this.transports)
    transports.add(transport)
    return Procedure.override(procedure, this, { transports })
  }

  withDependencies<Deps extends Dependencies>(dependencies: Deps) {
    const procedure = new Procedure<
      ProcedureDeps & ApplyProcedureTransport<ProcedureTransports, Deps>,
      ProcedureTransports,
      ProcedureInput,
      ProcedureOutput,
      ProcedureInputTypeProvider,
      ProcedureOutputTypeProvider,
      ProcedureHandlerType<
        ProcedureDeps & ApplyProcedureTransport<ProcedureTransports, Deps>,
        ProcedureInput,
        ProcedureOutput,
        ProcedureInputTypeProvider,
        ProcedureOutputTypeProvider
      >
    >()
    return Procedure.override(procedure, this, {
      dependencies: merge(this.dependencies, dependencies),
    })
  }

  withInput<Input>(input: ProcedureOptionType<ProcedureDeps, Input>) {
    const procedure = new Procedure<
      ProcedureDeps,
      ProcedureTransports,
      Input,
      ProcedureOutput,
      ProcedureInputTypeProvider,
      ProcedureOutputTypeProvider,
      ProcedureHandlerType<
        ProcedureDeps,
        Input,
        ProcedureOutput,
        ProcedureInputTypeProvider,
        ProcedureOutputTypeProvider
      >
    >()

    input = this.parsers.input?.transform?.(input) ?? input

    return Procedure.override(procedure, this, { input })
  }

  withOutput<Output>(output: Output) {
    const procedure = new Procedure<
      ProcedureDeps,
      ProcedureTransports,
      ProcedureInput,
      Output,
      ProcedureInputTypeProvider,
      ProcedureOutputTypeProvider,
      ProcedureHandlerType<
        ProcedureDeps,
        ProcedureInput,
        Output,
        ProcedureInputTypeProvider,
        ProcedureOutputTypeProvider
      >
    >()

    output = this.parsers.input?.transform?.(output) ?? output

    return Procedure.override(procedure, this, { output })
  }

  withOptions(options: Extra) {
    const procedure = new Procedure<
      ProcedureDeps,
      ProcedureTransports,
      ProcedureInput,
      ProcedureOutput,
      ProcedureInputTypeProvider,
      ProcedureOutputTypeProvider,
      ProcedureHandler
    >()
    return Procedure.override(procedure, this, {
      options: merge(this.options, options),
    })
  }

  withHandler<
    H extends ProcedureHandlerType<
      ProcedureDeps,
      ProcedureInput,
      ProcedureOutput,
      ProcedureInputTypeProvider,
      ProcedureOutputTypeProvider
    >,
  >(handler: H) {
    const procedure = new Procedure<
      ProcedureDeps,
      ProcedureTransports,
      ProcedureInput,
      ProcedureOutput,
      ProcedureInputTypeProvider,
      ProcedureOutputTypeProvider,
      H
    >()
    return Procedure.override(procedure, this, { handler })
  }

  withGuards(...guards: this['guards']) {
    const procedure = new Procedure<
      ProcedureDeps,
      ProcedureTransports,
      ProcedureInput,
      ProcedureOutput,
      ProcedureInputTypeProvider,
      ProcedureOutputTypeProvider,
      ProcedureHandler
    >()
    return Procedure.override(procedure, this, {
      guards: [...this.guards, ...guards],
    })
  }

  withMiddlewares(...middlewares: this['middlewares']) {
    const procedure = new Procedure<
      ProcedureDeps,
      ProcedureTransports,
      ProcedureInput,
      ProcedureOutput,
      ProcedureInputTypeProvider,
      ProcedureOutputTypeProvider,
      ProcedureHandler
    >()
    return Procedure.override(procedure, this, {
      middlewares: [...this.middlewares, ...middlewares],
    })
  }

  withTimeout(timeout: number) {
    if (typeof timeout !== 'number' || timeout < 0)
      throw new Error('Timeout must be a positive number')
    const procedure = new Procedure<
      ProcedureDeps,
      ProcedureTransports,
      ProcedureInput,
      ProcedureOutput,
      ProcedureInputTypeProvider,
      ProcedureOutputTypeProvider,
      ProcedureHandler
    >()
    return Procedure.override(procedure, this, { timeout })
  }

  withParser(parser: BaseParser) {
    const procedure = new Procedure<
      ProcedureDeps,
      ProcedureTransports,
      ProcedureInput,
      ProcedureOutput,
      ProcedureInputTypeProvider,
      ProcedureOutputTypeProvider,
      ProcedureHandler
    >()
    return Procedure.override(procedure, this, {
      parsers: { input: parser, output: parser },
    })
  }

  withInputParser(parser: BaseParser) {
    const procedure = new Procedure<
      ProcedureDeps,
      ProcedureTransports,
      ProcedureInput,
      ProcedureOutput,
      ProcedureInputTypeProvider,
      ProcedureOutputTypeProvider,
      ProcedureHandler
    >()
    return Procedure.override(procedure, this, {
      parsers: { ...this.parsers, input: parser },
    })
  }

  withOutputParser(parser: BaseParser) {
    const procedure = new Procedure<
      ProcedureDeps,
      ProcedureTransports,
      ProcedureInput,
      ProcedureOutput,
      ProcedureInputTypeProvider,
      ProcedureOutputTypeProvider,
      ProcedureHandler
    >()
    return Procedure.override(procedure, this, {
      parsers: { ...this.parsers, output: parser },
    })
  }

  withTypeProvider<T extends TypeProvider>() {
    const procedure = new Procedure<
      ProcedureDeps,
      ProcedureTransports,
      ProcedureInput,
      ProcedureOutput,
      T,
      T,
      ProcedureHandlerType<ProcedureDeps, ProcedureInput, ProcedureOutput, T, T>
    >()
    return Procedure.override(procedure, this)
  }

  withInputTypeProvider<T extends TypeProvider>() {
    const procedure = new Procedure<
      ProcedureDeps,
      ProcedureTransports,
      ProcedureInput,
      ProcedureOutput,
      T,
      ProcedureOutputTypeProvider,
      ProcedureHandlerType<
        ProcedureDeps,
        ProcedureInput,
        ProcedureOutput,
        T,
        ProcedureOutputTypeProvider
      >
    >()
    return Procedure.override(procedure, this)
  }

  withOutputTypeProvider<T extends TypeProvider>() {
    const procedure = new Procedure<
      ProcedureDeps,
      ProcedureTransports,
      ProcedureInput,
      ProcedureOutput,
      ProcedureInputTypeProvider,
      T,
      ProcedureHandlerType<
        ProcedureDeps,
        ProcedureInput,
        ProcedureOutput,
        ProcedureInputTypeProvider,
        T
      >
    >()
    return Procedure.override(procedure, this)
  }
}

export type ProcedureCallOptions = {
  transport: BaseTransport
  connection: BaseTransportConnection
  procedure: AnyProcedure
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

  find(name: string, transport: BaseTransport) {
    let procedure: Procedure
    try {
      procedure = this.application.registry.getByName('procedure', name)
    } catch (error) {
      throw NotFound()
    }

    const isAllowed = procedure.transports.has(transport.constructor as any)
    if (isAllowed) return procedure

    throw NotFound()
  }

  async call(callOptions: ProcedureCallOptions) {
    const { payload, container, connection, procedure } = callOptions

    const path = {
      procedure,
      name: this.application.registry.getName('procedure', procedure),
    }

    container.provide(Procedure.connection, connection)

    try {
      this.handleTransport(callOptions)
      const handler = await this.createProcedureHandler(callOptions, path)
      return await handler(payload)
    } catch (error) {
      throw await this.handleFilters(error)
    }
  }

  private async createProcedureHandler(
    callOptions: ProcedureCallOptions,
    path: ApiPath,
  ) {
    const { connection, procedure, container } = callOptions

    const middlewareCtx: MiddlewareContext = {
      connection,
      path,
      container,
    }

    const middlewares = await this.resolveMiddlewares(callOptions)

    const { timeout = this.options.timeout } = procedure

    const handleProcedure = async (payload: any) => {
      const middleware = middlewares?.next().value
      if (middleware) {
        const next = (newPayload = payload) => handleProcedure(newPayload)
        return middleware(middlewareCtx, next, payload)
      } else {
        await this.handleGuards(callOptions, path)
        const { dependencies } = procedure
        const context = await container.createContext(dependencies)

        const input = await this.handleSchema(
          procedure,
          'input',
          payload,
          context,
        )

        const result = await this.handleTimeout(
          procedure.handler(context, input),
          timeout,
        )

        const output = await this.handleSchema(
          procedure,
          'output',
          result,
          context,
        )

        return output
      }
    }

    return handleProcedure
  }

  private async resolveMiddlewares(callOptions: ProcedureCallOptions) {
    const { procedure, container } = callOptions
    const middlewareProviders = [
      ...this.application.registry.middlewares,
      ...procedure.middlewares,
    ]
    const middlewares = await Promise.all(
      middlewareProviders.map((p) => container.resolve(p)),
    )
    return middlewares[Symbol.iterator]()
  }

  private handleTransport({ procedure, transport }: ProcedureCallOptions) {
    if (procedure.transports) {
      for (const transportClass of procedure.transports) {
        if (transport instanceof transportClass) return
      }

      throw NotFound()
    }
  }

  private handleTimeout(response: any, timeout?: number) {
    const applyTimeout = timeout && response instanceof Promise
    const error = new ApiError(ErrorCode.RequestTimeout, 'Request Timeout')
    return applyTimeout ? withTimeout(response, timeout, error) : response
  }

  private async handleGuards(callOptions: ProcedureCallOptions, path: ApiPath) {
    const { procedure, container, connection } = callOptions
    const providers = [...this.application.registry.guards, ...procedure.guards]
    const guards = await Promise.all(providers.map((p) => container.resolve(p)))
    const guardOptions = Object.freeze({ connection, path })
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

  private async handleSchema(
    procedure: Procedure,
    type: 'input' | 'output',
    payload: any,
    context: any,
  ) {
    const parser = procedure.parsers[type]
    if (!parser) return payload
    const schema = procedure[type]
    if (!schema) return payload
    return parser!.parse(schema, payload, context)
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

export abstract class BaseParser {
  abstract parse(schema: any, data: any, ctx: any): any

  transform?(schema: any): any

  toJsonSchema(schema: any): any {
    return {}
  }
}
