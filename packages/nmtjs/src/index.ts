import { Application, asOptional } from '@nmtjs/application'
import {
  builtin as _builtin,
  createFactoryInjectable,
  createLazyInjectable,
  createValueInjectable,
} from '@nmtjs/application'
import {
  createConsolePrettyDestination,
  createContractProcedure,
  createFilter,
  createGuard,
  createMiddleware,
  createPlugin,
  createProcedure,
  createTransport,
} from '@nmtjs/application'
import { createContractService, createService } from '@nmtjs/application'
import {
  $createSubscription,
  createContractSubscription,
} from '@nmtjs/application'
import { createTask } from '@nmtjs/application'
import { ApplicationServer } from '@nmtjs/server'

export namespace n {
  export const app = (...args: ConstructorParameters<typeof Application>) =>
    new Application(...args)

  export const server = (
    ...args: ConstructorParameters<typeof ApplicationServer>
  ) => new ApplicationServer(...args)

  export const optional = asOptional
  export const value = createValueInjectable
  export const lazy = createLazyInjectable
  export const factory = createFactoryInjectable
  export const task = createTask
  export const procedure = createContractProcedure
  export const service = createContractService
  export const subscription = createContractSubscription
  export const middleware = createMiddleware
  export const guard = createGuard
  export const filter = createFilter
  export const builtin = _builtin
  export const transport = createTransport
  export const plugin = createPlugin
  export const logging = {
    console: createConsolePrettyDestination,
  }

  export namespace contractless {
    export const procedure = createProcedure
    export const service = createService
    export const $subscription = $createSubscription
  }
}

export const neemata = n

export { c } from '@nmtjs/contract'
export { t } from '@nmtjs/type'

export {
  builtin,
  type GuardLike,
  type MiddlewareLike,
  type FilterLike,
  type AnyInjectable,
  ApiError,
  WorkerType,
  Hook,
  Scope,
} from '@nmtjs/application'
export { ErrorCode, TransportType, type ApiBlobMetadata } from '@nmtjs/common'
export {
  injectWorkerOptions,
  provideWorkerOptions,
  WTSubManagerPlugin,
} from '@nmtjs/server'
