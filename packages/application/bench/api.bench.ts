import { Container, createLogger, Scope } from '@nmtjs/core'
import { GatewayInjectables } from '@nmtjs/gateway'
import { bench, describe } from 'vitest'

import {
  ApplicationApi,
  createMiddleware,
  createProcedure,
} from '../src/index.ts'

const BENCHMARK_OPTIONS = {
  time: 200,
  warmupTime: 50,
  iterations: 200,
  warmupIterations: 50,
} as const

const payload = Object.freeze({ caseId: 'case-0001', revision: 17 })
const response = Object.freeze({ accepted: true, revision: 18 })
const passthroughMiddleware = createMiddleware(
  (_context, _call, next, middlewarePayload) => next(middlewarePayload),
)

function createCall(middleware = false) {
  const logger = createLogger({ pinoOptions: { enabled: false } }, 'benchmark')
  const container = new Container({ logger })
  const procedure = createProcedure({
    middlewares: middleware ? [passthroughMiddleware] : [],
    handler: () => response,
  })
  const api = new ApplicationApi({
    container,
    logger,
    procedures: new Map([['cases/update', { procedure, path: [] }]]),
    meta: [],
    guards: new Set(),
    middlewares: new Set(),
    filters: new Set(),
  })

  const connectionContainer = container.fork(Scope.Connection)
  const connectionAbort = new AbortController()
  connectionContainer.provide(
    GatewayInjectables.connectionAbortSignal,
    connectionAbort.signal,
  )

  const callContainer = connectionContainer.fork(Scope.Call)
  const clientAbort = new AbortController()
  callContainer.provide(
    GatewayInjectables.rpcClientAbortSignal,
    clientAbort.signal,
  )

  return () =>
    api.call({
      connection: {} as never,
      procedure: 'cases/update',
      container: callContainer,
      payload,
      signal: clientAbort.signal,
    })
}

const directCall = createCall()
const middlewareCall = createCall(true)

describe('application unary API pipeline', () => {
  bench(
    'direct procedure',
    async () => {
      await directCall()
    },
    BENCHMARK_OPTIONS,
  )
  bench(
    'one passthrough middleware',
    async () => {
      await middlewareCall()
    },
    BENCHMARK_OPTIONS,
  )
})
