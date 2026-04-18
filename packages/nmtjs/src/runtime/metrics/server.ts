import { createServer } from 'node:http'

import type { Logger } from '@nmtjs/core'
import { Pushgateway } from 'prom-client'

import type { ServerConfig } from '../server/config.ts'

export async function createMetricsServer(
  logger: Logger,
  config: Exclude<ServerConfig['metrics'], undefined>,
) {
  const { workerRegistry: registry } = await import('./registry.ts')
  const { host = '0.0.0.0', port = 9187, path = '/metrics', push } = config

  let intervalRef: any

  if (push) {
    const { url = 'http://127.0.0.1:9091', interval, name: jobName } = push
    const gateway = new Pushgateway(url, {}, registry)
    intervalRef = setInterval(() => {
      gateway
        .pushAdd({ jobName })
        .catch((cause) =>
          logger.error(new Error('Metrics push error', { cause })),
        )
    }, interval)
  }

  const server = createServer((req, res) => {
    const url = new URL(`http://${req.headers.host || 'localhost'}${req.url}`)
    if (url.pathname === path) {
      res.setHeader('Content-Type', registry.contentType)
      registry
        .workerMetrics()
        .then((metrics) => {
          res.writeHead(200)
          res.end(metrics)
        })
        .catch((cause) => {
          logger.error(new Error('Metrics collection error', { cause }))
          res.writeHead(500)
          res.end('Internal Server Error')
        })
    } else {
      res.writeHead(404)
      res.end('Not Found')
    }
  })

  return {
    start: () =>
      new Promise<void>((resolve) =>
        server.listen({ host: host, port: port }, resolve),
      ),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        if (intervalRef) clearInterval(intervalRef)
        server.close((err) => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      }),
  }
}

export type MetricsServer = Awaited<ReturnType<typeof createMetricsServer>>
