import type { MaybePromise } from '@nmtjs/common'
import { IsStreamProcedureContract } from '@nmtjs/contract'
import { CoreInjectables, loggerLocalStorage } from '@nmtjs/core'

import type { ApiCallContext } from './types.ts'
import { createMiddleware } from './middlewares.ts'

const defaultContext = (options: ApiCallContext, payload: unknown) => {
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

export const LoggingCallContextMiddleware = (
  cb: (
    options: ApiCallContext,
    payload: unknown,
  ) => MaybePromise<object> = defaultContext,
) =>
  createMiddleware({
    handle: async (_, call, next, payload) => {
      const loggingContext = await cb(call, payload)
      return loggerLocalStorage.run(loggingContext, async () => {
        return next()
      })
    },
  })

export const LoggingCallMiddleware = (
  options: {
    level?: 'info' | 'debug' | 'trace'
    errorLevel?: 'warn' | 'error' | 'fatal'
    includePayload?: boolean
    includeResponse?: boolean
    includeStreamChunks?: boolean
  } = {},
) =>
  createMiddleware({
    dependencies: { logger: CoreInjectables.logger('RPC') },
    handle: async ({ logger }, call, next, payload) => {
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
