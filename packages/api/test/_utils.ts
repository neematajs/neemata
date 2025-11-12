import type { Logger } from '@nmtjs/core'
import type { ConnectionOptions } from '@nmtjs/protocol/server'
import { noopFn } from '@nmtjs/common'
import { c } from '@nmtjs/contract'
import { Container, CoreInjectables, createLogger, Scope } from '@nmtjs/core'
import { Connection } from '@nmtjs/protocol/server'
import { t } from '@nmtjs/type'

import type { ApiOptions } from '../src/api.ts'
import type { CreateProcedureParams } from '../src/procedure.ts'
import { Api } from '../src/api.ts'
import { createContractProcedure } from '../src/procedure.ts'
import { ApiRegistry } from '../src/registry.ts'
import { createContractRouter } from '../src/router.ts'

export const TestRouterContract = c.router({
  routes: { testProcedure: c.procedure({ input: t.any(), output: t.any() }) },
  events: { testEvent: c.event({ payload: t.string() }) },
  name: 'TestRouter',
})

export const testConnection = (options: ConnectionOptions = { data: {} }) =>
  new Connection(options)

export const testProcedure = (
  params: CreateProcedureParams<
    typeof TestRouterContract.routes.testProcedure,
    any
  >,
) => createContractProcedure(TestRouterContract.routes.testProcedure, params)

export const testRouter = (options?: {
  routes: { testProcedure: ReturnType<typeof testProcedure> }
}) =>
  createContractRouter(TestRouterContract, {
    routes: { testProcedure: testProcedure(noopFn), ...options?.routes },
  })

const defaultApiOptions: ApiOptions = { timeout: 1000 }

export interface TestApiRuntime {
  api: Api
  registry: ApiRegistry
  logger: Logger
  options: ApiOptions
  container: Container
  initialize(): Promise<void>
  dispose(): Promise<void>
  createCallContainer(): Container
}

export const testApiRuntime = (
  options: Partial<ApiOptions> = {},
): TestApiRuntime => {
  const apiOptions: ApiOptions = { ...defaultApiOptions, ...options }
  const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
  const registry = new ApiRegistry({ logger })
  const container = new Container({ registry, logger })
  const api = new Api({ container, registry, logger }, apiOptions)

  return {
    api,
    registry,
    logger,
    options: apiOptions,
    container,
    async initialize() {
      if (!container.contains(CoreInjectables.logger)) {
        await container.provide(CoreInjectables.logger, logger)
      }
      await container.initialize()
    },
    async dispose() {
      await container.dispose()
      registry.clear()
    },
    createCallContainer() {
      return container.fork(Scope.Call)
    },
  }
}
