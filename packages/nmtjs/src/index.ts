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

import type {
  ApplicationConfig,
  ApplicationHostDefinition,
  ApplicationHostDefinitionOptions,
  ApplicationTransport,
} from '@nmtjs/application'
import { defineApplicationHost } from '@nmtjs/application'
import { JsonFormat } from '@nmtjs/json-format/server'
import { MsgpackFormat } from '@nmtjs/msgpack-format/server'
import { ProtocolFormats } from '@nmtjs/protocol/server'

export {
  ApiError,
  createContractProcedure as contractProcedure,
  createContractRouter as contractRouter,
  createFilter as filter,
  createGuard as guard,
  createHook as hook,
  createMeta as meta,
  createMiddleware as middleware,
  createProcedure as procedure,
  createRootRouter as rootRouter,
  createStream as stream,
  createRouter as router,
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

/**
 * Defines an application host with the default native codec registry
 * (JSON + MessagePack) when `formats` is not provided — native codecs are
 * owned by the host composition (see the application-interfaces plan, D13).
 */
export function host<
  const App extends ApplicationConfig,
  const Transports extends Record<string, ApplicationTransport>,
>(
  application: App,
  options: ApplicationHostDefinitionOptions<Transports>,
): ApplicationHostDefinition<App, Transports> {
  return defineApplicationHost(application, {
    ...options,
    formats:
      options.formats ??
      new ProtocolFormats([new JsonFormat(), new MsgpackFormat()]),
  })
}
