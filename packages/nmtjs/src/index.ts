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
  createConsolePrettyDestination,
  createFactoryInjectable,
  createLazyInjectable,
  createOptionalInjectable,
  createPlugin,
  createValueInjectable,
} from '@nmtjs/core'
import { createTransport, ProtocolInjectables } from '@nmtjs/protocol/server'
import { ApplicationServer } from '@nmtjs/server'

export namespace neemata {
  export const app = (...args: ConstructorParameters<typeof Application>) =>
    new Application(...args)

  export const server = (
    ...args: ConstructorParameters<typeof ApplicationServer>
  ) => new ApplicationServer(...args)

  export const optional = createOptionalInjectable
  export const value = createValueInjectable
  export const lazy = createLazyInjectable
  export const factory = createFactoryInjectable
  export const task = createTask
  export const procedure = createContractProcedure
  export const namespace = createContractNamespace
  export const middleware = createMiddleware
  export const guard = createGuard
  export const filter = createFilter
  export const injectables = {
    ...CoreInjectables,
    ...ProtocolInjectables,
    ...AppInjectables,
  }
  export const transport = createTransport
  export const plugin = createPlugin
  export const logging = {
    console: createConsolePrettyDestination,
  }

  export namespace contractless {
    export const procedure = createProcedure
    export const namespace = createNamespace
  }
}

export { neemata as n }

export {
  ApiError,
  type ApplicationWorkerOptions,
  type FilterLike,
  type GuardLike,
  type MiddlewareLike,
  WorkerType,
} from '@nmtjs/application'
export { c, contract } from '@nmtjs/contract'

export { type AnyInjectable, Hook, type Logger, Scope } from '@nmtjs/core'
export {
  ErrorCode,
  ProtocolBlob,
  type ProtocolBlobMetadata,
  TransportType,
} from '@nmtjs/protocol/common'

export { t, type } from '@nmtjs/type'
