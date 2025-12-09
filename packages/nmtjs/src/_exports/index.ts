import {
  CoreInjectables,
  createConsolePrettyDestination,
  createFactoryInjectable,
  createLazyInjectable,
  createOptionalInjectable,
  createValueInjectable,
} from '@nmtjs/core'
import { createTransport, GatewayInjectables } from '@nmtjs/gateway'
import {
  createContractProcedure,
  createContractRouter,
  createFilter,
  createGuard,
  createHook,
  createJob,
  createMiddleware,
  createPlugin,
  createProcedure,
  createRouter,
  createStep,
  defineApplication,
  defineServer,
  RuntimeInjectables,
} from '@nmtjs/runtime'

export const neemata = {
  app: defineApplication,
  server: defineServer,
  injectables: {
    ...CoreInjectables,
    ...GatewayInjectables,
    ...(RuntimeInjectables as typeof RuntimeInjectables),
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
  router: createRouter,
  contractRouter: createContractRouter,
  procedure: createProcedure,
  contractProcedure: createContractProcedure,
  middleware: createMiddleware,
  guard: createGuard,
  filter: createFilter,
  job: createJob,
  step: createStep,
  hook: createHook,
}

export { c } from '@nmtjs/contract'
export { Scope } from '@nmtjs/core'
export { ErrorCode, ProtocolBlob } from '@nmtjs/protocol'
export { t } from '@nmtjs/type'
export { ApiError, defineApplication, LifecycleHook } from 'nmtjs/runtime'

export { neemata as n }
export default neemata
