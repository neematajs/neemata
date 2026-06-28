import { CoreInjectables, createConsolePrettyDestination } from '@nmtjs/core'
import { EventingInjectables } from '@nmtjs/eventing'
import { GatewayInjectables } from '@nmtjs/gateway'
import { JobInjectables } from '@nmtjs/jobs'
import {
  createCounterMetric,
  createGaugeMetric,
  createHistogramMetric,
  createSummaryMetric,
} from '@nmtjs/metrics'
import { PubSubInjectables } from '@nmtjs/pubsub'

type Injectables = Readonly<
  typeof CoreInjectables &
    typeof GatewayInjectables &
    typeof JobInjectables &
    typeof PubSubInjectables &
    typeof EventingInjectables
>

type Metrics = Readonly<{
  counter: typeof createCounterMetric
  gauge: typeof createGaugeMetric
  histogram: typeof createHistogramMetric
  summary: typeof createSummaryMetric
}>

export {
  ApiError,
  createContractProcedure as contractProcedure,
  createContractRouter as contractRouter,
  createFilter as filter,
  createGuard as guard,
  createHook as hook,
  createMeta as meta,
  createMiddleware as middleware,
  createPlugin as plugin,
  createProcedure as procedure,
  createRootRouter as rootRouter,
  createRouter as router,
  defineApplication as app,
  defineApplicationHost as host,
  implement as implementRouter,
  LifecycleHook,
} from '@nmtjs/application'
export { blobType, c } from '@nmtjs/contract'
export {
  CoreInjectables,
  createFactoryInjectable as factory,
  createLazyInjectable as lazy,
  createValueInjectable as value,
  MetadataKind,
  optional,
  Scope,
} from '@nmtjs/core'
export {
  createEventingPlugin as eventingPlugin,
  EventingInjectables,
  implement as implementSubscription,
} from '@nmtjs/eventing'
export {
  type ConnectionIdentityType,
  createTransport as transport,
  GatewayHook,
  GatewayInjectables,
  ProxyableTransportType,
} from '@nmtjs/gateway'
export {
  createJob as job,
  createJobRouterOperation as jobOperation,
  createJobsApplicationPlugin as jobsPlugin,
  createJobsRouter as jobRouter,
  createStep as step,
  JobInjectables,
} from '@nmtjs/jobs'
export { ConnectionType, ErrorCode, ProtocolBlob } from '@nmtjs/protocol'
export {
  createPubSubPlugin as pubsubPlugin,
  PubSubInjectables,
} from '@nmtjs/pubsub'
export { t } from '@nmtjs/type'

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
  ...JobInjectables,
  ...PubSubInjectables,
  ...EventingInjectables,
})
