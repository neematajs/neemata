import type { NeemPluginHooks, NeemRuntimeServerHealth } from '@nmtjs/neem'
import { Counter, Gauge, Registry } from '@nmtjs/prom-client'

export type NeemMetricsObserver = { recordHealth(): void }

export type NeemMetricsLifecycle = NeemMetricsObserver & {
  hooks: NeemPluginHooks
}

export function createNeemMetricsLifecycle(options: {
  registry?: Registry
  getHealth: () => NeemRuntimeServerHealth
}): NeemMetricsLifecycle {
  const registry = options.registry ?? new Registry()
  const lifecycleEvents = new Counter({
    name: 'neem_lifecycle_events_total',
    help: 'Neem host lifecycle events.',
    labelNames: ['event'],
    registers: [registry],
  })
  const runtimeReady = new Gauge({
    name: 'neem_runtime_ready',
    help: 'Neem runtime readiness by runtime name.',
    labelNames: ['runtime'],
    registers: [registry],
  })
  const runtimePoolThreads = new Gauge({
    name: 'neem_runtime_pool_threads',
    help: 'Neem runtime thread count by runtime and state.',
    labelNames: ['runtime', 'state'],
    registers: [registry],
  })

  const recordLifecycle = (event: string) => {
    lifecycleEvents.inc({ event })
    recordHealth()
  }

  function recordHealth() {
    const health = options.getHealth()
    for (const { name: runtime, pool } of health.runtimes) {
      const ready = pool.state === 'ready' ? 1 : 0
      runtimeReady.set({ runtime }, ready)

      for (const state of ['ready', 'failed', 'stopped', 'starting'] as const) {
        runtimePoolThreads.set({ runtime, state }, pool[state])
      }
    }
  }

  return {
    recordHealth,
    hooks: {
      'server:start': () => recordLifecycle('server:start'),
      'server:ready': () => recordLifecycle('server:ready'),
      'server:reload': () => recordLifecycle('server:reload'),
      'server:stop': () => recordLifecycle('server:stop'),
      'server:fail': () => recordLifecycle('server:fail'),
      'runtime:start': (event) =>
        recordLifecycle(`runtime:start:${event.name}`),
      'runtime:ready': (event) =>
        recordLifecycle(`runtime:ready:${event.name}`),
      'runtime:reload': (event) =>
        recordLifecycle(`runtime:reload:${event.name}`),
      'runtime:stop': (event) => recordLifecycle(`runtime:stop:${event.name}`),
      'runtime:fail': (event) => recordLifecycle(`runtime:fail:${event.name}`),
      'worker:start': (event) => recordLifecycle(`worker:start:${event.name}`),
      'worker:ready': (event) => recordLifecycle(`worker:ready:${event.name}`),
      'worker:stop': (event) => recordLifecycle(`worker:stop:${event.name}`),
      'worker:fail': (event) => recordLifecycle(`worker:fail:${event.name}`),
    },
  }
}
