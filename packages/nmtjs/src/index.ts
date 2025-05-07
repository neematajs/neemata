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

export * as type from '@nmtjs/type'
export * as temporal from '@nmtjs/type/temporal'
export * as contract from '@nmtjs/contract'
export * as core from '@nmtjs/core'
export * as application from '@nmtjs/application'
export * as server from '@nmtjs/server'
export * as wsTransport from '@nmtjs/ws-transport'
export * as jsonFormat from '@nmtjs/json-format/server'

export { Scope, Hook } from '@nmtjs/core'
export { ErrorCode, TransportType } from '@nmtjs/protocol/common'
export { ApiError, WorkerType } from '@nmtjs/application'
export { t } from '@nmtjs/type'
export { c } from '@nmtjs/contract'

export { neemata as n }
export default neemata
