import type { ClassConstructorArgs } from '@nmtjs/common'
import type { Metric, MetricConfiguration } from 'prom-client'
import { Counter, Gauge, Histogram, Summary } from 'prom-client'

import { registry } from './registry.ts'

export const createMetric =
  <T extends Metric>(contructor: new (config: MetricConfiguration<any>) => T) =>
  (config: ClassConstructorArgs<T>[0]): T =>
    new contructor({
      ...config,
      registers: [...(config.registers ?? []), registry],
    })

export const createCounterMetric = createMetric(Counter)
export const createGaugeMetric = createMetric(Gauge)
export const createHistogramMetric = createMetric(Histogram)
export const createSummaryMetric = createMetric(Summary)
