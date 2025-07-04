import {
  AppInjectables,
  createApplication,
  createContractNamespace,
  createContractProcedure,
  createFilter,
  createGuard,
  createMiddleware,
  createNamespace,
  createProcedure,
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
    console: createConsolePrettyDestination,
  },
  optional: createOptionalInjectable,
  value: createValueInjectable,
  lazy: createLazyInjectable,
  factory: createFactoryInjectable,
  class: createClassInjectable,
  extendClass: createExtendableClassInjectable,
  task: createTask,
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
