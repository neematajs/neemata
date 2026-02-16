import type { ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'

import { StaticClient } from '@nmtjs/client/static'
import { c } from '@nmtjs/contract'
import { HttpTransportFactory } from '@nmtjs/http-client'
import { JsonFormat } from '@nmtjs/json-format/client'
import { ProtocolVersion } from '@nmtjs/protocol'
import { t } from '@nmtjs/type'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  E2E_CWD,
  startNeemataCliServer,
  stopServerProcess,
} from './_utils/server.ts'

const contract = c.router({
  routes: {
    streamCount: c.procedure({
      input: t.object({ count: t.number() }),
      output: t.object({ index: t.number() }),
      stream: true,
    }),
  },
})

const CWD = E2E_CWD
const BASIC_CONFIG_PATH = resolve(CWD, 'src/basic/neemata.config.js')
const ALLOWLIST_CONFIG_PATH = resolve(
  CWD,
  'src/basic/neemata.cors-allowlist.config.js',
)
const CORS_TRUE_CONFIG_PATH = resolve(
  CWD,
  'src/basic/neemata.cors-true.config.js',
)
const SERVER_HOST = DEFAULT_SERVER_HOST
const SERVER_PORT = DEFAULT_SERVER_PORT
const SERVER_URL = `http://${SERVER_HOST}:${SERVER_PORT}`
const ALLOWED_ORIGIN = 'https://allowed-origin.test'
const DISALLOWED_ORIGIN = 'https://blocked-origin.test'

async function startServer(
  command: 'preview',
  options: { timeout?: number; configPath?: string } = {},
) {
  return await startNeemataCliServer({
    command,
    cwd: CWD,
    configPath: options.configPath,
    timeoutMs: options.timeout ?? 15000,
    startupDelayMs: 1000,
    host: SERVER_HOST,
    port: SERVER_PORT,
  })
}

function createHttpClient() {
  return new StaticClient(
    { contract, protocol: ProtocolVersion.v1, format: new JsonFormat() },
    HttpTransportFactory,
    { url: SERVER_URL },
  )
}

describe('Playground E2E - HTTP CORS', { timeout: 30000 }, () => {
  let serverProcess: ChildProcess | null = null

  beforeAll(async () => {
    serverProcess = await startServer('preview', {
      configPath: ALLOWLIST_CONFIG_PATH,
    })
  }, 20000)

  afterAll(async () => {
    if (serverProcess) {
      await stopServerProcess(serverProcess)
    }
  })

  it('returns preflight CORS headers for allowed origin', async () => {
    const response = await fetch(`${SERVER_URL}/ping`, {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type, Accept',
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(
      ALLOWED_ORIGIN,
    )
    expect(response.headers.get('access-control-allow-methods')).toContain(
      'POST',
    )
    expect(response.headers.get('access-control-allow-headers')).toContain(
      'Content-Type',
    )
    expect(response.headers.get('access-control-allow-headers')).toContain(
      'Authorization',
    )
    expect(response.headers.get('access-control-allow-credentials')).toBe(
      'true',
    )
  })

  it('omits preflight CORS headers for disallowed origin', async () => {
    const response = await fetch(`${SERVER_URL}/ping`, {
      method: 'OPTIONS',
      headers: {
        Origin: DISALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'POST',
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('access-control-allow-methods')).toBeNull()
    expect(response.headers.get('access-control-allow-headers')).toBeNull()
  })

  it('applies CORS headers to non-preflight request for allowed origin', async () => {
    const response = await fetch(`${SERVER_URL}/ping`, {
      method: 'GET',
      headers: { Origin: ALLOWED_ORIGIN },
    })

    expect(response.headers.get('access-control-allow-origin')).toBe(
      ALLOWED_ORIGIN,
    )
    expect(response.headers.get('access-control-allow-methods')).toContain(
      'POST',
    )
    expect(response.headers.get('access-control-allow-headers')).toContain(
      'Content-Type',
    )
  })

  it('does not apply CORS headers to non-preflight request for disallowed origin', async () => {
    const response = await fetch(`${SERVER_URL}/ping`, {
      method: 'GET',
      headers: { Origin: DISALLOWED_ORIGIN },
    })

    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('access-control-allow-methods')).toBeNull()
    expect(response.headers.get('access-control-allow-headers')).toBeNull()
  })
})

describe('Playground E2E - HTTP CORS (cors: true)', { timeout: 30000 }, () => {
  let serverProcess: ChildProcess | null = null

  beforeAll(async () => {
    serverProcess = await startServer('preview', {
      configPath: CORS_TRUE_CONFIG_PATH,
    })
  }, 20000)

  afterAll(async () => {
    if (serverProcess) {
      await stopServerProcess(serverProcess)
    }
  })

  it('returns CORS headers for any origin on preflight', async () => {
    const response = await fetch(`${SERVER_URL}/ping`, {
      method: 'OPTIONS',
      headers: {
        Origin: DISALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'POST',
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(
      DISALLOWED_ORIGIN,
    )
    expect(response.headers.get('access-control-allow-methods')).toContain(
      'POST',
    )
    expect(response.headers.get('access-control-allow-headers')).toContain(
      'Content-Type',
    )
    expect(response.headers.get('access-control-allow-headers')).toContain(
      'Authorization',
    )
    expect(response.headers.get('access-control-allow-credentials')).toBe(
      'true',
    )
  })

  it('returns CORS headers for any origin on non-preflight requests', async () => {
    const response = await fetch(`${SERVER_URL}/ping`, {
      method: 'GET',
      headers: { Origin: DISALLOWED_ORIGIN },
    })

    expect(response.headers.get('access-control-allow-origin')).toBe(
      DISALLOWED_ORIGIN,
    )
    expect(response.headers.get('access-control-allow-methods')).toContain(
      'POST',
    )
    expect(response.headers.get('access-control-allow-headers')).toContain(
      'Content-Type',
    )
  })
})

describe('Playground E2E - HTTP Streaming', { timeout: 30000 }, () => {
  let serverProcess: ChildProcess | null = null

  beforeAll(async () => {
    serverProcess = await startServer('preview', {
      configPath: BASIC_CONFIG_PATH,
    })
  }, 20000)

  afterAll(async () => {
    if (serverProcess) {
      await stopServerProcess(serverProcess)
    }
  })

  it('streams values over HTTP transport', async () => {
    const client = createHttpClient()
    const result: number[] = []

    const streamResponse = await client.stream.streamCount({ count: 5 })
    const maybeStream = streamResponse as unknown
    const stream =
      typeof maybeStream === 'function'
        ? (
            maybeStream as (options?: {
              signal?: AbortSignal
            }) => AsyncIterable<{ index: number }>
          )({})
        : streamResponse

    for await (const chunk of stream) {
      result.push(chunk.index)
    }

    expect(result).toEqual([0, 1, 2, 3, 4])
  })
})
