import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'

import type { Logger } from '@nmtjs/core'
import { describe, expect, it, vi } from 'vitest'

import {
  createCombinedMetricsCollector,
  createMetricsServer,
} from '../src/server.ts'

describe('createMetricsServer', () => {
  it('serves metrics at the configured path and returns 404 elsewhere', async () => {
    const logger = createTestLogger()
    const metrics = createMetricsServer({
      logger,
      config: { host: '127.0.0.1', port: 0, path: '/custom-metrics' },
      registry: { contentType: 'text/plain', metrics: () => 'test_metric 2\n' },
    })

    try {
      await metrics.start()
      const baseUrl = getLoggedMetricsBaseUrl(logger, '/custom-metrics')

      await expect(fetchText(`${baseUrl}/missing`)).resolves.toEqual({
        status: 404,
        body: 'Not Found',
      })
      await expect(fetchText(`${baseUrl}/custom-metrics`)).resolves.toEqual({
        status: 200,
        body: 'test_metric 2\n',
      })
    } finally {
      await metrics.stop()
    }
  })

  it('returns 500 and logs when metrics collection fails', async () => {
    const logger = createTestLogger()
    const metrics = createMetricsServer({
      logger,
      config: { host: '127.0.0.1', port: 0 },
      registry: {
        contentType: 'text/plain',
        metrics: () => {
          throw new Error('collector failed')
        },
      },
    })

    try {
      await metrics.start()
      const baseUrl = getLoggedMetricsBaseUrl(logger)

      await expect(fetchText(`${baseUrl}/metrics`)).resolves.toEqual({
        status: 500,
        body: 'Internal Server Error',
      })
      expect(logger.error).toHaveBeenCalledWith(expect.any(Error))
    } finally {
      await metrics.stop()
    }
  })

  it('pushes metrics once before stopping when push is configured', async () => {
    const requests: Array<{ method?: string; url?: string; body: string }> = []
    const gateway = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => {
        body += String(chunk)
      })
      request.on('end', () => {
        requests.push({ method: request.method, url: request.url, body })
        response.writeHead(202)
        response.end('ok')
      })
    })
    await listen(gateway)

    const logger = createTestLogger()
    const metrics = createMetricsServer({
      logger,
      config: {
        host: '127.0.0.1',
        port: 0,
        push: {
          url: `http://127.0.0.1:${getPort(gateway)}`,
          name: 'neem-test',
          interval: 60_000,
        },
      },
      registry: { contentType: 'text/plain', metrics: () => 'test_metric 1\n' },
    })

    try {
      await metrics.start()
      await metrics.stop()
    } finally {
      await close(gateway)
    }

    expect(requests).toEqual([
      {
        method: 'POST',
        url: '/metrics/job/neem-test',
        body: 'test_metric 1\n',
      },
    ])
    expect(logger.error).not.toHaveBeenCalled()
  })
})

describe('createCombinedMetricsCollector', () => {
  it('combines host and worker registry metrics with one trailing newline', async () => {
    const registry = {
      contentType: 'text/plain',
      metrics: async () => '\nhost_metric 1\n',
    }
    const workerRegistry = { workerMetrics: async () => '\nworker_metric 2\n' }

    const collector = createCombinedMetricsCollector(
      registry as never,
      workerRegistry as never,
    )

    expect(collector.contentType).toBe('text/plain')
    await expect(collector.metrics()).resolves.toBe(
      'host_metric 1\n\nworker_metric 2\n',
    )
  })
})

function createTestLogger() {
  return { debug: vi.fn(), error: vi.fn() } as unknown as Logger
}

async function fetchText(url: string) {
  const response = await fetch(url)
  return { status: response.status, body: await response.text() }
}

function getLoggedMetricsBaseUrl(logger: Logger, path = '/metrics'): string {
  const debug = logger.debug as ReturnType<typeof vi.fn>
  const message = String(debug.mock.calls[0]?.[0])
  const suffix = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = message.match(new RegExp(`(https?://[^\\s]+)${suffix}$`))
  if (!match) throw new Error(`Missing metrics listen log: ${message}`)
  return match[1]!
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function getPort(server: Server): number {
  const address = server.address() as AddressInfo
  return address.port
}
