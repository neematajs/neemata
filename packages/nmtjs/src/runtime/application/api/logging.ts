import type { MaybePromise } from '@nmtjs/common'
import { CoreInjectables, loggerLocalStorage } from '@nmtjs/core'

import type { ApiCallContext } from './types.ts'
import { createMiddleware } from './middlewares.ts'

const defaultContext = (options: ApiCallContext, payload: unknown) => {
  return {
    $connection: {
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
  options: { includePayload?: boolean; includeResult?: boolean } = {
    includePayload: true,
    includeResult: true,
  },
) =>
  createMiddleware({
    handle: async (_, call, next, payload) => {
      const logger = await call.container.resolve(
        CoreInjectables.logger('CallLogger'),
      )
      logger.info(
        options.includePayload
          ? {
              $rpc: {
                procedure: call.procedure.contract.name,
                payload: payload,
              },
            }
          : { $rpc: { procedure: call.procedure.contract.name } },
        'RPC call',
      )
      try {
        const result = await next()
        if (options.includeResult)
          logger.info(
            { $rpc: { procedure: call.procedure.contract.name, result } },
            'RPC call result',
          )
        return result
      } catch (error) {
        logger.error(
          { $rpc: { procedure: call.procedure.contract.name, error } },
          'RPC call error',
        )
        throw error
      }
    },
  })
