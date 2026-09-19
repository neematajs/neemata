import type { Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'

import type { Logger } from '@nmtjs/core'
import type { Registry, RegistryContentType } from '@nmtjs/prom-client'
import { Pushgateway, WorkerRegistry } from '@nmtjs/prom-client'

import { metricsWorkerRegistry } from './registry.ts'

const DEFAULT_HOST = '0.0.0.0'
const DEFAULT_PORT = 9187
const DEFAULT_PATH = '/metrics'
const DEFAULT_PUSH_URL = 'http://127.0.0.1:9091'

/**
 * Deploy-time `NEEM_METRICS_*` env vars override these when the Neem plugin
 * is used; see `neem/env.ts`.
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
  const host = config.host ?? DEFAULT_HOST
  const port = config.port ?? DEFAULT_PORT
  const path = config.path ?? DEFAULT_PATH
  let server: Server | undefined
  let push: MetricsPush | undefined

  async function respond(response: ServerResponse) {
    try {
      const metrics = await collectMetrics(registry)
      response.writeHead(200)
      response.end(metrics)
    } catch (cause) {
      logger.error(new Error('Metrics collection error', { cause }))
      response.writeHead(500)
      response.end('Internal Server Error')
    }
  }

  return {
    async start() {
      if (server) return
      const httpServer = createServer((request, response) => {
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
        void respond(response)
      })
      server = httpServer

      if (config.push) {
        push = createPush(config.push, registry, logger)
        push.start()
      }

      await new Promise<void>((resolve) => {
        httpServer.listen({ host, port }, resolve)
      })
      logger.debug(getMetricsServerListenMessage(httpServer, path))
    },
    async stop() {
      const pending = push
      push = undefined
      await pending?.stop()

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

type MetricsPush = { start(): void; stop(): Promise<void> }

function createPush(
  config: NonNullable<MetricsServerConfig['push']>,
  registry: MetricsRegistry,
  logger: Logger,
): MetricsPush {
  const { name: jobName, interval } = config
  const gateway = new Pushgateway(
    config.url ?? DEFAULT_PUSH_URL,
    {},
    createPushGatewayRegistry(registry),
  )
  let timer: NodeJS.Timeout | undefined

  const flush = () =>
    gateway.pushAdd({ jobName }).catch((cause) => {
      logger.error(new Error('Metrics push error', { cause }))
    })

  return {
    start() {
      timer = setInterval(() => void flush(), interval)
    },
    async stop() {
      if (timer) clearInterval(timer)
      timer = undefined
      // a final push so the last scrape window is not lost
      await flush()
    },
  }
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

// Pushgateway only ever calls `.metrics()`, so a collector stands in for a
// full Registry here.
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
