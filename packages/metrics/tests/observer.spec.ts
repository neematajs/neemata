import type { NeemRuntimeServerHealth } from '@nmtjs/neem'
import { Registry } from '@nmtjs/prom-client'
import { describe, expect, it } from 'vitest'

import { createNeemMetricsLifecycle } from '../src/neem/observer.ts'

describe('createNeemMetricsLifecycle', () => {
  it('records lifecycle events and current runtime health gauges', async () => {
    const registry = new Registry()
    const lifecycle = createNeemMetricsLifecycle({
      registry,
      getHealth: () => testHealth,
    })

    await lifecycle.hooks['runtime:ready']?.({ name: 'api' } as never)

    const metrics = await registry.metrics()
    expect(metrics).toContain(
      'neem_lifecycle_events_total{event="runtime:ready:api"} 1',
    )
    expect(metrics).toContain('neem_runtime_ready{runtime="api"} 1')
    expect(metrics).toContain(
      'neem_runtime_pool_threads{runtime="api",state="ready"} 2',
    )
    expect(metrics).toContain(
      'neem_runtime_pool_threads{runtime="api",state="failed"} 1',
    )
    expect(metrics).toContain(
      'neem_runtime_pool_threads{runtime="api",state="stopped"} 0',
    )
    expect(metrics).toContain(
      'neem_runtime_pool_threads{runtime="api",state="starting"} 0',
    )
  })

  it('records health without lifecycle increments', async () => {
    const registry = new Registry()
    const lifecycle = createNeemMetricsLifecycle({
      registry,
      getHealth: () => ({
        ...testHealth,
        runtimes: [
          {
            ...testHealth.runtimes[0]!,
            pool: {
              ...testHealth.runtimes[0]!.pool,
              state: 'degraded',
              ready: 1,
              failed: 2,
            },
          },
        ],
      }),
    })

    lifecycle.recordHealth()

    const metrics = await registry.metrics()
    expect(metrics).not.toContain('neem_lifecycle_events_total{')
    expect(metrics).toContain('neem_runtime_ready{runtime="api"} 0')
    expect(metrics).toContain(
      'neem_runtime_pool_threads{runtime="api",state="ready"} 1',
    )
    expect(metrics).toContain(
      'neem_runtime_pool_threads{runtime="api",state="failed"} 2',
    )
  })
})

const testHealth = {
  mode: 'development',
  outDir: 'dist',
  runtimeNames: ['api'],
  artifactCount: 1,
  state: 'running',
  revision: 1,
  ready: true,
  runtimes: [
    {
      name: 'api',
      ready: true,
      pool: {
        name: 'api',
        state: 'ready',
        size: 3,
        ready: 2,
        failed: 1,
        stopped: 0,
        starting: 0,
      },
      threads: [],
    },
  ],
  proxy: {
    enabled: false,
    running: false,
    ready: false,
    upstreams: [],
    appliedUpstreams: [],
    pending: 0,
    failedUpstreams: [],
  },
} satisfies NeemRuntimeServerHealth
