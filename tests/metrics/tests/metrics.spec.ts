import { createServer as createNetServer } from 'node:net'

import { createLogger } from '@nmtjs/core'
import {
  createMetricsRegistry,
  createMetricsServer,
  createNeemMetricsObserver,
  registerDefaultMetrics,
} from '@nmtjs/metrics'
import { describe, expect, it } from 'vitest'

import { createNeemHostHooks } from '../../../packages/neem/src/internal/runtime/hooks.ts'

describe('@nmtjs/metrics', () => {
  it('serves Prometheus text from the metrics endpoint', async () => {
    const registry = createMetricsRegistry()
    registerDefaultMetrics(registry)
    const port = await getFreePort()
    const server = createMetricsServer({
      logger: createTestLogger(),
      registry,
      config: { host: '127.0.0.1', port },
    })

    await server.start()
    try {
      const response = await fetch(`http://127.0.0.1:${port}/metrics`)
      const body = await response.text()

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/plain')
      expect(body).toContain('# HELP')
    } finally {
      await server.stop()
    }
  })

  it('records Neem lifecycle and health metrics', async () => {
    const hooks = createNeemHostHooks()
    const registry = createMetricsRegistry()
    createNeemMetricsObserver({
      hooks,
      registry,
      logger: createTestLogger(),
      getHealth: () => ({
        mode: 'production',
        outDir: '/tmp/neem',
        runtimeNames: ['api'],
        artifactCount: 1,
        state: 'running',
        revision: 1,
        ready: true,
        proxy: { enabled: false, running: false, upstreams: [] },
        runtimes: [
          {
            name: 'api',
            pool: {
              name: 'runtime:api',
              state: 'ready',
              size: 1,
              ready: 1,
              failed: 0,
              stopped: 0,
              starting: 0,
            },
            threads: [],
          },
        ],
      }),
    })

    await hooks.callHook('server:start', { mode: 'production' })
    const metrics = await registry.metrics()

    expect(metrics).toContain('neem_lifecycle_events_total')
    expect(metrics).toContain('neem_runtime_ready')
    expect(metrics).toContain('neem_runtime_pool_threads')
  })
})

function createTestLogger() {
  return createLogger({ pinoOptions: { enabled: false } }, 'metrics-test')
}

async function getFreePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to allocate test port')
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
  return address.port
}
