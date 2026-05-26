import type { Server } from 'node:http'
import { createServer } from 'node:http'

import type { Logger } from '@nmtjs/core'
import type { Registry } from '@nmtjs/prom-client'
import { Pushgateway, WorkerRegistry } from '@nmtjs/prom-client'

import { metricsWorkerRegistry } from './registry.ts'

export type MetricsServerConfig = {
  path?: string
  port?: number
  host?: string
  push?: { url?: string; name: string; interval: number }
}

export type MetricsServer = { start(): Promise<void>; stop(): Promise<void> }

export function createMetricsServer(options: {
  logger: Logger
  config?: MetricsServerConfig
  registry?: Registry | WorkerRegistry<any>
}): MetricsServer {
  const logger = options.logger
  const config = options.config ?? {}
  const registry = options.registry ?? metricsWorkerRegistry
  const host = config.host ?? '0.0.0.0'
  const port = config.port ?? 9187
  const path = config.path ?? '/metrics'
  let server: Server | undefined
  let pushInterval: NodeJS.Timeout | undefined

  return {
    async start() {
      if (server) return
      server = createServer((request, response) => {
        const url = new URL(
          request.url ?? '/',
          `http://${request.headers.host ?? 'localhost'}`,
        )
        if (url.pathname !== path) {
          response.writeHead(404)
          response.end('Not Found')
          return
        }

        response.setHeader('content-type', registry.contentType)
        Promise.resolve(collectMetrics(registry))
          .then((metrics) => {
            response.writeHead(200)
            response.end(metrics)
          })
          .catch((cause) => {
            logger.error(new Error('Metrics collection error', { cause }))
            response.writeHead(500)
            response.end('Internal Server Error')
          })
      })

      if (config.push) {
        const gateway = new Pushgateway(
          config.push.url ?? 'http://127.0.0.1:9091',
          {},
          registry,
        )
        pushInterval = setInterval(() => {
          gateway.pushAdd({ jobName: config.push!.name }).catch((cause) => {
            logger.error(new Error('Metrics push error', { cause }))
          })
        }, config.push.interval)
      }

      await new Promise<void>((resolve) => {
        server!.listen({ host, port }, resolve)
      })
    },
    async stop() {
      if (pushInterval) clearInterval(pushInterval)
      pushInterval = undefined

      const current = server
      server = undefined
      if (!current) return
      await new Promise<void>((resolve, reject) => {
        current.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    },
  }
}

function collectMetrics(registry: Registry | WorkerRegistry<any>) {
  return registry instanceof WorkerRegistry
    ? registry.workerMetrics()
    : registry.metrics()
}
