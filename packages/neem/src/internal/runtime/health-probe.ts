import type { Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'

import type { Logger } from '@nmtjs/core'

import type { NeemHealthConfig } from '../../public/config.ts'
import type { NeemRuntimeServerHealth } from './server.ts'
import { createNeemChildLogger } from './logger.ts'

export type NeemHealthProbeOptions = {
  config: NeemHealthConfig
  logger: Logger
  getHealth: () => NeemRuntimeServerHealth
}

export class NeemHealthProbeServer {
  private readonly logger: Logger
  private readonly hostname: string
  private readonly port: number
  private readonly healthPath: string
  private readonly readyPath: string
  private server: Server | undefined

  constructor(private readonly options: NeemHealthProbeOptions) {
    this.logger = createNeemChildLogger(options.logger, 'Neem health')
    this.hostname = options.config.hostname ?? '127.0.0.1'
    this.port = options.config.port
    this.healthPath = normalizeProbePath(
      options.config.paths?.health,
      '/health',
    )
    this.readyPath = normalizeProbePath(options.config.paths?.ready, '/ready')
  }

  async start(): Promise<void> {
    if (this.server) return

    const server = createServer((request, response) => {
      const path = new URL(
        request.url ?? '/',
        `http://${request.headers.host ?? '127.0.0.1'}`,
      ).pathname

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        writeJson(response, request.method === 'HEAD', 405, {
          ok: false,
          error: 'Method not allowed',
        })
        return
      }

      if (path === this.healthPath) {
        const health = this.options.getHealth()
        const status = getHealthStatus(health)
        writeJson(response, request.method === 'HEAD', status, {
          ok: status < 400,
          health: serializeHealth(health),
        })
        return
      }

      if (path === this.readyPath) {
        const health = this.options.getHealth()
        writeJson(
          response,
          request.method === 'HEAD',
          health.ready ? 200 : 503,
          { ok: health.ready, health: serializeHealth(health) },
        )
        return
      }

      writeJson(response, request.method === 'HEAD', 404, {
        ok: false,
        error: 'Not found',
      })
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.port, this.hostname)
    })

    this.server = server
    this.logger.info(
      {
        hostname: this.hostname,
        port: this.port,
        health: this.healthPath,
        ready: this.readyPath,
      },
      'Neem health probe started',
    )
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
    this.logger.info('Neem health probe stopped')
  }

  matches(config: NeemHealthConfig | undefined): boolean {
    if (!config) return false
    return (
      this.hostname === (config.hostname ?? '127.0.0.1') &&
      this.port === config.port &&
      this.healthPath === normalizeProbePath(config.paths?.health, '/health') &&
      this.readyPath === normalizeProbePath(config.paths?.ready, '/ready')
    )
  }
}

function getHealthStatus(health: NeemRuntimeServerHealth): number {
  return health.state === 'failed' || health.state === 'stopped' ? 503 : 200
}

function normalizeProbePath(
  path: string | undefined,
  fallback: string,
): string {
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
