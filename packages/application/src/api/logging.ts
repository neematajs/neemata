import type { MaybePromise } from '@nmtjs/common'
import type { AnyInjectable } from '@nmtjs/core'
import { IsStreamContract } from '@nmtjs/contract'
import {
  CoreInjectables,
  createFactoryInjectable,
  forkLogger,
  loggerLocalStorage,
} from '@nmtjs/core'

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

const callLogger = createFactoryInjectable({
  dependencies: { logger: CoreInjectables.logger },
  create: ({ logger }) =>
    forkLogger(logger, 'rpc', { redact: CALL_LOG_REDACT_PATHS }),
})

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
      return loggerLocalStorage.run(loggingContext, next)
    },
  })

export type LoggingCallMiddlewareOptions = {
  level?: 'info' | 'debug' | 'trace'
  errorLevel?: 'warn' | 'error' | 'fatal'
  includePayload?: boolean
  includeResponse?: boolean
  includeStreamChunks?: boolean
}

const DEFAULT_LOGGING_OPTIONS = Object.freeze({
  level: 'info',
  errorLevel: 'error',
  includePayload: true,
  includeResponse: true,
  includeStreamChunks: true,
} satisfies Required<LoggingCallMiddlewareOptions>)

export const LoggingCallMiddleware = (
  options: AnyInjectable<LoggingCallMiddlewareOptions>,
): AnyMiddleware =>
  createMiddleware({
    dependencies: {
      logger: callLogger,
      options,
    },
    handler: async ({ logger, options }, call, next, payload) => {
      const {
        includePayload,
        includeResponse,
        includeStreamChunks,
        level,
        errorLevel,
      } = { ...DEFAULT_LOGGING_OPTIONS, ...options }

      const logFn = logger[level].bind(logger)
      const errorLogFn = logger[errorLevel].bind(logger)
      const { callId } = call
      const procedure = call.procedure.contract.name
      const isStream = IsStreamContract(call.procedure.contract)

      logFn(includePayload ? { procedure, payload } : { procedure }, 'RPC call')

      try {
        const response = await next()

        let responseLog: { result: 'success'; response?: unknown }
        if (!includeResponse) {
          responseLog = { result: 'success' }
        } else if (isStream) {
          responseLog = { result: 'success', response: 'Stream' }
        } else {
          responseLog = { result: 'success', response }
        }
        logFn(responseLog, 'RPC response')

        if (isStream && includeStreamChunks) {
          return async function* (...args: any[]) {
            try {
              for await (const chunk of response(...args)) {
                logFn({ callId, chunk }, 'RPC stream chunk')
                yield chunk
              }
              logFn({ callId }, 'RPC stream end')
            } catch (error) {
              errorLogFn({ callId, error }, 'RPC stream error')
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
