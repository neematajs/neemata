// biome-ignore lint/correctness/noUnusedImports: TSC wants it
// biome-ignore assist/source/organizeImports: TSC wants it
import type { kClassInjectable, kInjectable } from '@nmtjs/core'

import {
  AppInjectables,
  createApplication,
  createContractNamespace,
  createContractProcedure,
  createContractRouter,
  createFilter,
  createGuard,
  createMiddleware,
  createNamespace,
  createProcedure,
  createRouter,
  createTask,
} from '@nmtjs/application'
import {
  CoreInjectables,
  createClassInjectable,
  createConsolePrettyDestination,
  createExtendableClassInjectable,
  createFactoryInjectable,
  createLazyInjectable,
  createOptionalInjectable,
  createPlugin,
  createValueInjectable,
} from '@nmtjs/core'
import { createTransport, ProtocolInjectables } from '@nmtjs/protocol/server'
import { createServer } from '@nmtjs/server'

export const neemata = {
  app: createApplication,
  server: createServer,
  injectables: {
    ...CoreInjectables,
    ...ProtocolInjectables,
    ...AppInjectables,
  },
  transport: createTransport,
  plugin: createPlugin,
  logging: {
    console:
      // TODO: TSC wants it
      createConsolePrettyDestination as typeof createConsolePrettyDestination,
  },
  optional: createOptionalInjectable,
  value: createValueInjectable,
  lazy: createLazyInjectable,
  factory: createFactoryInjectable,
  class: createClassInjectable,
  extendClass: createExtendableClassInjectable,
  task: createTask,
  router: createRouter,
  contractRouter: createContractRouter,
  namespace: createNamespace,
  contractNamespace: createContractNamespace,
  procedure: createProcedure,
  contractProcedure: createContractProcedure,
  middleware: createMiddleware,
  guard: createGuard,
  filter: createFilter,
}

export { ApiError, WorkerType } from '@nmtjs/application'
export { c } from '@nmtjs/contract'
export { Hook, Scope } from '@nmtjs/core'
export { ErrorCode, ProtocolBlob, TransportType } from '@nmtjs/protocol'
export { createStreamResponse } from '@nmtjs/protocol/server'
export { t } from '@nmtjs/type'

export { neemata as n }
export default neemata
