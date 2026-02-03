// biome-ignore assist/source/organizeImports: for ts
import type {} from 'pino'

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
  createJobRouterOperation,
  createJobsRouter,
  createMiddleware,
  createPlugin,
  createProcedure,
  createRootRouter,
  createRouter,
  createStep,
  defineApplication,
  defineServer,
  RuntimeInjectables,
} from './runtime/index.ts'
import {
  createCounterMetric,
  createGaugeMetric,
  createHistogramMetric,
  createSummaryMetric,
} from './runtime/metrics/metric.ts'

export namespace neemata {
  export const app = defineApplication
  export const server = defineServer
  export const injectables = Object.freeze({
    ...CoreInjectables,
    ...GatewayInjectables,
    ...RuntimeInjectables,
  })
  export const inject = injectables
  export const transport = createTransport
  export const plugin = createPlugin
  export const logging = Object.freeze({
    console: createConsolePrettyDestination,
  })
  export const value = createValueInjectable
  export const lazy = createLazyInjectable
  export const factory = createFactoryInjectable
  export const rootRouter = createRootRouter
  export const router = createRouter
  export const contractRouter = createContractRouter
  export const jobRouter = createJobsRouter
  export const jobRouterOperation = createJobRouterOperation
  export const procedure = createProcedure
  export const contractProcedure = createContractProcedure
  export const middleware = createMiddleware
  export const guard = createGuard
  export const filter = createFilter
  export const job = createJob
  export const step = createStep
  export const hook = createHook
  export const metrics = Object.freeze({
    counter: createCounterMetric,
    gauge: createGaugeMetric,
    histogram: createHistogramMetric,
    summary: createSummaryMetric,
  })
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
