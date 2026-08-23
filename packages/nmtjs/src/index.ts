import { CoreInjectables, createConsolePrettyDestination } from '@nmtjs/core'
import { GatewayInjectables } from '@nmtjs/gateway'
import {
  createCounterMetric,
  createGaugeMetric,
  createHistogramMetric,
  createSummaryMetric,
} from '@nmtjs/metrics'
import { PubSubInjectables } from '@nmtjs/pubsub'

type Injectables = Readonly<
  typeof CoreInjectables & typeof GatewayInjectables & typeof PubSubInjectables
>

type Metrics = Readonly<{
  counter: typeof createCounterMetric
  gauge: typeof createGaugeMetric
  histogram: typeof createHistogramMetric
  summary: typeof createSummaryMetric
}>

export { defineApplicationHost as host } from '@nmtjs/application'
export {
  ApiError,
  createProcedure as procedure,
  createContractProcedure as contractProcedure,
  createStream as stream,
  createContractStream as contractStream,
  createRouter as router,
  createContractRouter as contractRouter,
  createRootRouter as rootRouter,
  createFilter as filter,
  createGuard as guard,
  createHook as hook,
  createMeta as meta,
  createMiddleware as middleware,
  defineApplication as app,
  implement as implementRouter,
} from '@nmtjs/application'
export { createEnvConfig as envConfig, EnvConfigError } from '@nmtjs/config'
export { blobType, c } from '@nmtjs/contract'
export {
  CoreInjectables,
  createPlugin as plugin,
  createFactoryInjectable as factory,
  createHandler as handler,
  createLazyInjectable as lazy,
  createValueInjectable as value,
  ExecutionEnvironmentLifecycleHook,
  MetadataKind,
  optional,
  Scope,
} from '@nmtjs/core'
export {
  type ConnectionIdentityType,
  createTransport as transport,
  GatewayHook,
  GatewayInjectables,
  ProxyableTransportType,
} from '@nmtjs/gateway'
export { ConnectionType, ErrorCode, ProtocolBlob } from '@nmtjs/protocol'
export {
  createPubSubPlugin as pubsubPlugin,
  PubSubInjectables,
} from '@nmtjs/pubsub'
export { t } from '@nmtjs/type'
export {
  defineSchedule as schedule,
  defineTask as task,
  defineWorkflow as workflow,
  implementTask,
  implementWorkflow,
  WorkflowAttemptTimeoutError,
} from '@nmtjs/workflows'

export const logging = Object.freeze({
  console: createConsolePrettyDestination,
})

export const metrics: Metrics = Object.freeze({
  counter: createCounterMetric,
  gauge: createGaugeMetric,
  histogram: createHistogramMetric,
  summary: createSummaryMetric,
})

export const inject: Injectables = Object.freeze({
  ...CoreInjectables,
  ...GatewayInjectables,
  ...PubSubInjectables,
})
