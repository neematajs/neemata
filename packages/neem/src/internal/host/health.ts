import type { Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'

import type { Logger } from '@nmtjs/core'

import type { NeemHealthConfig } from '../../public/config.ts'
import type { NeemRuntimeServerHealth } from '../../public/runtime.ts'
import { childLogger } from '../shared/logger.ts'

export type HealthProbeOptions = {
  config: NeemHealthConfig
  logger: Logger
  getHealth: () => NeemRuntimeServerHealth
}

export class HealthProbe {
  private readonly logger: Logger
  private readonly hostname: string
  private readonly port: number
  private readonly healthPath: string
  private readonly readyPath: string
  private server: Server | undefined

  constructor(private readonly options: HealthProbeOptions) {
    this.logger = childLogger(options.logger, 'neem:health')
    this.hostname = options.config.hostname ?? '127.0.0.1'
    this.port = options.config.port
    this.healthPath = normalizePath(options.config.paths?.health, '/health')
    this.readyPath = normalizePath(options.config.paths?.ready, '/ready')
  }

  async start(): Promise<void> {
    if (this.server) return

    const server = createServer((request, response) => {
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

      if (path === this.healthPath) {
        const health = this.options.getHealth()
        const status =
          health.state === 'failed' || health.state === 'stopped' ? 503 : 200
        writeJson(response, headOnly, status, {
          ok: status < 400,
          health: serializeHealth(health),
        })
        return
      }

      if (path === this.readyPath) {
        const health = this.options.getHealth()
        writeJson(response, headOnly, health.ready ? 200 : 503, {
          ok: health.ready,
          health: serializeHealth(health),
        })
        return
      }

      writeJson(response, headOnly, 404, { ok: false, error: 'Not found' })
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
    this.logger.info('Neem health probe started')
    this.logger.trace(
      {
        hostname: this.hostname,
        port: this.port,
        health: this.healthPath,
        ready: this.readyPath,
      },
      'Neem health probe options',
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
      this.healthPath === normalizePath(config.paths?.health, '/health') &&
      this.readyPath === normalizePath(config.paths?.ready, '/ready')
    )
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
