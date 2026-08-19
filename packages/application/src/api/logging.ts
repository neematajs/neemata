import type {
  AnyInjectable,
  Dependencies,
  HandlerFn,
  HandlerInput,
} from '@nmtjs/core'
import { IsStreamProcedureContract } from '@nmtjs/contract'
import { CoreInjectables, loggerLocalStorage } from '@nmtjs/core'

import type { AnyMiddleware, Middleware } from './middlewares.ts'
import type { ApiCallContext } from './types.ts'
import { createMiddleware } from './middlewares.ts'

export type LoggingCallContextHandlerFn<Deps extends Dependencies> = HandlerFn<
  Deps,
  [call: ApiCallContext, payload: unknown],
  object
>

export type LoggingCallContextParams<Deps extends Dependencies> = HandlerInput<
  Deps,
  [call: ApiCallContext, payload: unknown],
  object
>

const defaultContext = (_: object, options: ApiCallContext) => {
  return {
    callId: options.callId,
    connection: {
      id: options.connection.id,
      type: options.connection.type,
      transport: options.connection.transport,
      protocol: options.connection.protocol,
      identity: options.connection.identity,
    },
  }
}

export const LoggingCallContextMiddleware = <Deps extends Dependencies = {}>(
  paramsOrHandler: LoggingCallContextParams<Deps> = defaultContext,
): Middleware<Deps> => {
  const { dependencies = {} as Deps, handler } =
    typeof paramsOrHandler === 'function'
      ? { handler: paramsOrHandler }
      : paramsOrHandler

  return createMiddleware({
    dependencies,
    handler: async (ctx, call, next, payload) => {
      const loggingContext = await handler(ctx, call, payload)
      return loggerLocalStorage.run(loggingContext, async () => {
        return next()
      })
    },
  })
}

export type LoggingCallMiddlewareOptions = {
  level?: 'info' | 'debug' | 'trace'
  errorLevel?: 'warn' | 'error' | 'fatal'
  includePayload?: boolean
  includeResponse?: boolean
  includeStreamChunks?: boolean
}

export const LoggingCallMiddleware = (
  options: AnyInjectable<LoggingCallMiddlewareOptions>,
): AnyMiddleware =>
  createMiddleware({
    dependencies: { logger: CoreInjectables.logger('rpc'), options },
    handler: async ({ logger, options }, call, next, payload) => {
      const {
        includePayload,
        includeResponse,
        includeStreamChunks,
        level,
        errorLevel,
      } = {
        level: 'info' as const,
        errorLevel: 'error' as const,
        includePayload: true,
        includeResponse: true,
        includeStreamChunks: true,
        ...options,
      }

      const logFn = logger[level].bind(logger)
      const errorLogFn = logger[errorLevel].bind(logger)

      logFn(
        includePayload
          ? { procedure: call.procedure.contract.name, payload: payload }
          : { procedure: call.procedure.contract.name },
        'RPC call',
      )

      const isIterableProcedure = IsStreamProcedureContract(
        call.procedure.contract,
      )

      try {
        const response = await next()
        if (includeResponse) {
          if (isIterableProcedure) {
            logFn({ result: 'success', response: 'Stream' }, 'RPC response')
          } else {
            logFn({ result: 'success', response }, 'RPC response')
          }
        } else {
          logFn({ result: 'success' }, 'RPC response')
        }

        if (isIterableProcedure && includeStreamChunks) {
          return async function* (...args: any[]) {
            try {
              for await (const chunk of response(...args)) {
                logFn({ callId: call.callId, chunk }, 'RPC stream chunk')
                yield chunk
              }
              logFn({ callId: call.callId }, 'RPC stream end')
            } catch (error) {
              errorLogFn({ callId: call.callId, error }, 'RPC stream error')
              throw error
            }
          }
        }

        return response
      } catch (error) {
        errorLogFn({ error }, 'RPC error')
        throw error
      }
    },
  })
