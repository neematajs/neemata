import type {
  CounterConfiguration,
  GaugeConfiguration,
  HistogramConfiguration,
  SummaryConfiguration,
} from '@nmtjs/prom-client'
import { Counter, Gauge, Histogram, Summary } from '@nmtjs/prom-client'

import { metricsRegistry } from './registry.ts'

export const createCounterMetric = <N extends string>(
  configuration: CounterConfiguration<N>,
) =>
  new Counter({
    ...configuration,
    registers: [...(configuration.registers ?? []), metricsRegistry],
  })
export const createGaugeMetric = <N extends string>(
  configuration: GaugeConfiguration<N>,
) =>
  new Gauge({
    ...configuration,
    registers: [...(configuration.registers ?? []), metricsRegistry],
  })
export const createHistogramMetric = <N extends string>(
  configuration: HistogramConfiguration<N>,
) =>
  new Histogram({
    ...configuration,
    registers: [...(configuration.registers ?? []), metricsRegistry],
  })
export const createSummaryMetric = <N extends string>(
  configuration: SummaryConfiguration<N>,
) =>
  new Summary({
    ...configuration,
    registers: [...(configuration.registers ?? []), metricsRegistry],
  })
