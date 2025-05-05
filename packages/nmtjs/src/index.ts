import {
  AppInjectables,
  Application,
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
import { ApplicationServer } from '@nmtjs/server'

export const neemata = {
  app: (...args: ConstructorParameters<typeof Application>) =>
    new Application(...args),

  server: (...args: ConstructorParameters<typeof ApplicationServer>) =>
    new ApplicationServer(...args),

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

export { neemata as n }

export {
  ApiError,
  type ApplicationWorkerOptions,
  type ExtractApplicationAPIContract,
  type FilterLike,
  type GuardLike,
  type MiddlewareLike,
  WorkerType,
} from '@nmtjs/application'

export {
  c,
  contract,
  type TAPIContract,
  type TEventContract,
  type TNamespaceContract,
  type TProcedureContract,
  type TSubscriptionContract,
} from '@nmtjs/contract'

export { type AnyInjectable, Hook, type Logger, Scope } from '@nmtjs/core'

export {
  ErrorCode,
  ProtocolBlob,
  type ProtocolBlobMetadata,
  TransportType,
} from '@nmtjs/protocol/common'

export * from '@nmtjs/type'
