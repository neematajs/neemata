import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { createServer } from 'node:http'

import type { Logger } from '@nmtjs/core'

import type {
  NeemHealthConfig,
  NeemRuntimeServerHealth,
} from '../../shared/types.ts'
import { childLogger } from '../logger.ts'

export type HealthProbeOptions = {
  config: NeemHealthConfig
  logger: Logger
  getHealth: () => NeemRuntimeServerHealth
}

type ResolvedHealthConfig = {
  hostname: string
  port: number
  healthPath: string
  readyPath: string
}

export class HealthProbe {
  private readonly logger: Logger
  private readonly config: ResolvedHealthConfig
  private server: Server | undefined

  constructor(private readonly options: HealthProbeOptions) {
    this.logger = childLogger(options.logger, 'neem:health')
    this.config = resolveConfig(options.config)
  }

  async start(): Promise<void> {
    if (this.server) return

    const { hostname, port, healthPath, readyPath } = this.config
    const server = createServer((request, response) =>
      this.handle(request, response),
    )
    server.listen(port, hostname)
    await once(server, 'listening')

    this.server = server
    this.logger.debug('Neem health probe started')
    this.logger.trace(
      { hostname, port, health: healthPath, ready: readyPath },
      'Neem health probe options',
    )
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const path = new URL(
      request.url ?? '/',
      `http://${request.headers.host ?? '127.0.0.1'}`,
    ).pathname
    const headOnly = request.method === 'HEAD'

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      writeJson(response, headOnly, 405, {
        ok: false,
        error: 'Method not allowed',
      })
      return
    }

    if (path === this.config.healthPath) {
      const health = this.options.getHealth()
      const status =
        health.state === 'failed' || health.state === 'stopped' ? 503 : 200
      writeJson(response, headOnly, status, {
        ok: status < 400,
        health: serializeHealth(health),
      })
      return
    }

    if (path === this.config.readyPath) {
      const health = this.options.getHealth()
      writeJson(response, headOnly, health.ready ? 200 : 503, {
        ok: health.ready,
        health: serializeHealth(health),
      })
      return
    }

    writeJson(response, headOnly, 404, { ok: false, error: 'Not found' })
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (!server) return

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    this.logger.debug('Neem health probe stopped')
  }

  matches(config: NeemHealthConfig | undefined): boolean {
    if (!config) return false
    const other = resolveConfig(config)
    return (
      this.config.hostname === other.hostname &&
      this.config.port === other.port &&
      this.config.healthPath === other.healthPath &&
      this.config.readyPath === other.readyPath
    )
  }
}

function resolveConfig(config: NeemHealthConfig): ResolvedHealthConfig {
  return {
    hostname: config.hostname ?? '127.0.0.1',
    port: config.port,
    healthPath: normalizePath(config.paths?.health, '/health'),
    readyPath: normalizePath(config.paths?.ready, '/ready'),
  }
}

function normalizePath(path: string | undefined, fallback: string): string {
  if (!path) return fallback
  return path.startsWith('/') ? path : `/${path}`
}

function serializeHealth(health: NeemRuntimeServerHealth) {
  return {
    ...health,
    lastError: health.lastError
      ? { name: health.lastError.name, message: health.lastError.message }
      : undefined,
  }
}

function writeJson(
  response: ServerResponse,
  headOnly: boolean,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload)
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  response.end(headOnly ? undefined : body)
}
