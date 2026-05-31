import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'

import type { Logger } from '@nmtjs/core'
import { describe, expect, it, vi } from 'vitest'

import { createMetricsServer } from '../src/server.ts'

describe('createMetricsServer', () => {
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

    const logger = { info: vi.fn(), error: vi.fn() } as unknown as Logger
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
