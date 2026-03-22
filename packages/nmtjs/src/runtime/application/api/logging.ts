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
  } = { level: 'info', includePayload: true, includeResponse: true },
) =>
  createMiddleware({
    dependencies: { logger: CoreInjectables.logger('RPC') },
    handle: async ({ logger }, call, next, payload) => {
      const logFn = logger[options.level || 'info'].bind(logger)
      const errorLogFn = logger[options.errorLevel || 'error'].bind(logger)

      logFn(
        options.includePayload
          ? { procedure: call.procedure.contract.name, payload: payload }
          : { procedure: call.procedure.contract.name },
        'RPC call',
      )

      const isIterableProcedure = IsStreamProcedureContract(
        call.procedure.contract,
      )

      try {
        const response = await next()
        if (options.includeResponse) {
          if (isIterableProcedure) {
            logFn({ result: 'success', response: 'Stream' }, 'RPC response')
            return async function* (...args: any[]) {
              for await (const chunk of response(...args)) {
                logFn({ callId: call.callId, chunk }, 'RPC stream chunk')
                yield chunk
              }
            }
          } else {
            logFn({ result: 'success', response }, 'RPC response')
          }
        } else {
          logFn({ result: 'success' }, 'RPC response')
        }
        return response
      } catch (error) {
        errorLogFn({ error }, 'RPC error')
        throw error
      }
    },
  })
