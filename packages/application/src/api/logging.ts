import type { MaybePromise } from '@nmtjs/common'
import type { AnyInjectable } from '@nmtjs/core'
import { IsStreamProcedureContract } from '@nmtjs/contract'
import { CoreInjectables, loggerLocalStorage } from '@nmtjs/core'

import type { AnyMiddleware } from './middlewares.ts'
import type { ApiCallContext } from './types.ts'
import { createMiddleware } from './middlewares.ts'

const CALL_LOG_REDACT_PATHS = [
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  'payload.headers.authorization',
  'payload.headers.cookie',
  'payload.headers["set-cookie"]',
  'response.headers.authorization',
  'response.headers.cookie',
  'response.headers["set-cookie"]',
  'chunk.headers.authorization',
  'chunk.headers.cookie',
  'chunk.headers["set-cookie"]',
  'error.headers.authorization',
  'error.headers.cookie',
  'error.headers["set-cookie"]',
]

export type LoggingCallContextBuilder = (
  call: ApiCallContext,
  payload: unknown,
) => MaybePromise<object>

export const LoggingCallContextMiddleware = (
  builder: AnyInjectable<LoggingCallContextBuilder>,
): AnyMiddleware =>
  createMiddleware({
    dependencies: { builder },
    handler: async ({ builder }, call, next, payload) => {
      const loggingContext = await builder(call, payload)
      return loggerLocalStorage.run(loggingContext, async () => {
        return next()
      })
    },
  })

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
    dependencies: {
      logger: CoreInjectables.logger('rpc', {
        redact: CALL_LOG_REDACT_PATHS,
      }),
      options,
    },
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
