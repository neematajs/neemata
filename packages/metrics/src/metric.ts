import type { ClassConstructorArgs } from '@nmtjs/common'
import type { Metric, MetricConfiguration, Registry } from '@nmtjs/prom-client'
import { Counter, Gauge, Histogram, Summary } from '@nmtjs/prom-client'

import { metricsRegistry } from './registry.ts'

export const createMetric =
  <T extends Metric>(
    MetricConstructor: new (config: MetricConfiguration<any>) => T,
  ) =>
  (config: ClassConstructorArgs<T>[0] & { registry?: Registry }): T => {
    const { registry = metricsRegistry, ...metricConfig } = config
    return new MetricConstructor({
      ...metricConfig,
      registers: [...(metricConfig.registers ?? []), registry],
    } as MetricConfiguration<any>)
  }

export const createCounterMetric = createMetric(Counter)
export const createGaugeMetric = createMetric(Gauge)
export const createHistogramMetric = createMetric(Histogram)
export const createSummaryMetric = createMetric(Summary)
