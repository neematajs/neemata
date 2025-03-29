import {
  AppInjectables,
  Application,
  ApplicationApiError,
  createContractNamespace,
  createContractProcedure,
  createFilter,
  createGuard,
  createMiddleware,
  createNamespace,
  createProcedure,
} from '@nmtjs/application'
import { createTask } from '@nmtjs/application'
import {
  createConsolePrettyDestination,
  createFactoryInjectable,
  createPlugin,
} from '@nmtjs/core'
import { CoreInjectables } from '@nmtjs/core'
import { createLazyInjectable } from '@nmtjs/core'
import { createValueInjectable } from '@nmtjs/core'
import { markOptional } from '@nmtjs/core'
import { ProtocolInjectables, createTransport } from '@nmtjs/protocol/server'
import { ApplicationServer } from '@nmtjs/server'

export namespace n {
  export const app = (...args: ConstructorParameters<typeof Application>) =>
    new Application(...args)

  export const server = (
    ...args: ConstructorParameters<typeof ApplicationServer>
  ) => new ApplicationServer(...args)

  export const optional = markOptional
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

export const neemata = n

export const ApiError = ApplicationApiError

export { c, contract } from '@nmtjs/contract'
export { t, type } from '@nmtjs/type'

export {
  ApplicationApiError,
  type GuardLike,
  type MiddlewareLike,
  type FilterLike,
  WorkerType,
} from '@nmtjs/application'
export {
  ProtocolBlob,
  ErrorCode,
  TransportType,
  type ProtocolBlobMetadata,
} from '@nmtjs/protocol/common'
