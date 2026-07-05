import type { Server } from 'node:http'
import { createServer } from 'node:http'

import type { Logger } from '@nmtjs/core'
import type { Registry, RegistryContentType } from '@nmtjs/prom-client'
import { Pushgateway, WorkerRegistry } from '@nmtjs/prom-client'

import { metricsWorkerRegistry } from './registry.ts'

/**
 * When used via the Neem plugin, options are baked into the manifest at build
 * time; deploy-time env vars resolved at start override them:
 * `NEEM_METRICS_PORT`, `NEEM_METRICS_HOST`, `NEEM_METRICS_PATH`,
 * `NEEM_METRICS_PUSH_URL` (enables push when not configured here),
 * `NEEM_METRICS_PUSH_NAME`, `NEEM_METRICS_PUSH_INTERVAL` (milliseconds).
 */
export type MetricsServerConfig = {
  path?: string
  port?: number
  host?: string
  push?: { url?: string; name: string; interval: number }
}

export type MetricsServer = { start(): Promise<void>; stop(): Promise<void> }

export type MetricsCollector = {
  readonly contentType: RegistryContentType
  metrics(): string | Promise<string>
}

export type MetricsRegistry = Registry | WorkerRegistry<any> | MetricsCollector

export function createMetricsServer(options: {
  logger: Logger
  config?: MetricsServerConfig
  registry?: MetricsRegistry
}): MetricsServer {
  const logger = options.logger
  const config = options.config ?? {}
  const registry = options.registry ?? metricsWorkerRegistry
  const host = config.host ?? '0.0.0.0'
  const port = config.port ?? 9187
  const path = config.path ?? '/metrics'
  let server: Server | undefined
  let pushGateway: Pushgateway<RegistryContentType> | undefined
  let pushJobName: string | undefined
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
        Promise.resolve()
          .then(() => collectMetrics(registry))
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
        pushJobName = config.push.name
        pushGateway = new Pushgateway(
          config.push.url ?? 'http://127.0.0.1:9091',
          {},
          createPushGatewayRegistry(registry),
        )
        pushInterval = setInterval(() => {
          void pushMetrics(pushGateway, pushJobName, logger)
        }, config.push.interval)
      }

      await new Promise<void>((resolve) => {
        server!.listen({ host, port }, resolve)
      })
      logger.debug(getMetricsServerListenMessage(server, path))
    },
    async stop() {
      if (pushInterval) clearInterval(pushInterval)
      pushInterval = undefined
      await pushMetrics(pushGateway, pushJobName, logger)
      pushGateway = undefined
      pushJobName = undefined

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

async function pushMetrics(
  gateway: Pushgateway<RegistryContentType> | undefined,
  jobName: string | undefined,
  logger: Logger,
): Promise<void> {
  if (!gateway || !jobName) return
  await gateway.pushAdd({ jobName }).catch((cause) => {
    logger.error(new Error('Metrics push error', { cause }))
  })
}

function getMetricsServerListenMessage(server: Server, path: string): string {
  const address = server.address()
  if (!address || typeof address === 'string') {
    return `Metrics server started at ${path}`
  }

  const host = address.address
  const port = address.port
  return `Metrics server started at http://${formatUrlHost(host)}:${port}${path}`
}

function formatUrlHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

export function createCombinedMetricsCollector(
  registry: Registry,
  workerRegistry: WorkerRegistry<any> = metricsWorkerRegistry,
): MetricsCollector {
  return {
    get contentType() {
      return registry.contentType
    },
    async metrics() {
      const [hostMetrics, workerMetrics] = await Promise.all([
        registry.metrics(),
        workerRegistry.workerMetrics(),
      ])
      return joinMetrics(hostMetrics, workerMetrics)
    },
  }
}

function collectMetrics(registry: MetricsRegistry) {
  return registry instanceof WorkerRegistry
    ? registry.workerMetrics()
    : registry.metrics()
}

function createPushGatewayRegistry(registry: MetricsRegistry): Registry {
  return { metrics: () => collectMetrics(registry) } as Registry
}

function joinMetrics(...parts: string[]): string {
  const body = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n')
  return body ? `${body}\n` : ''
}
