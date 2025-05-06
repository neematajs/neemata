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

  optional: createOptionalInjectable,
  value: createValueInjectable,
  lazy: createLazyInjectable,
  factory: createFactoryInjectable,
  class: createClassInjectable,
  extendClass: createExtendableClassInjectable,
  task: createTask,
  procedure: createProcedure,
  namespace: createNamespace,
  middleware: createMiddleware,
  guard: createGuard,
  filter: createFilter,

  contract: {
    procedure: createContractProcedure,
    namespace: createContractNamespace,
  },

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
}

export * as type from '@nmtjs/type'
export * as temporal from '@nmtjs/type/temporal'
export * as contract from '@nmtjs/contract'
export * as core from '@nmtjs/core'
export * as application from '@nmtjs/application'
export * as server from '@nmtjs/server'
export * as wsTransport from '@nmtjs/ws-transport'
export * as jsonFormat from '@nmtjs/json-format/server'

export { neemata as n }
export default neemata
