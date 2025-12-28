import {
  CoreInjectables,
  createConsolePrettyDestination,
  createFactoryInjectable,
  createLazyInjectable,
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
  createJobsRouter,
  createMiddleware,
  createPlugin,
  createProcedure,
  createRootRouter,
  createRouter,
  createStep,
  defineApplication,
  defineServer,
  jobOperation,
  RuntimeInjectables,
} from './runtime/index.ts'

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
  value: createValueInjectable,
  lazy: createLazyInjectable,
  factory: createFactoryInjectable,
  rootRouter: createRootRouter,
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
  jobRouter: Object.assign(createJobsRouter, { operation: jobOperation }),
}

export { c } from '@nmtjs/contract'
export { Scope } from '@nmtjs/core'
export {
  type ConnectionIdentityType,
  GatewayHook,
  ProxyableTransportType,
} from '@nmtjs/gateway'
export { ConnectionType, ErrorCode, ProtocolBlob } from '@nmtjs/protocol'
export { t } from '@nmtjs/type'

export {
  ApiError,
  defineApplication,
  JobWorkerPool,
  LifecycleHook,
  StoreType,
  WorkerType,
} from './runtime/index.ts'

export { neemata as n }
export default neemata
