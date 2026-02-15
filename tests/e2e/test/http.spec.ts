import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { StaticClient } from '@nmtjs/client/static'
import { c } from '@nmtjs/contract'
import { HttpTransportFactory } from '@nmtjs/http-client'
import { JsonFormat } from '@nmtjs/json-format/client'
import { ProtocolVersion } from '@nmtjs/protocol'
import { t } from '@nmtjs/type'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const contract = c.router({
  routes: {
    streamCount: c.procedure({
      input: t.object({ count: t.number() }),
      output: t.object({ index: t.number() }),
      stream: true,
    }),
  },
})

const CWD = resolve(import.meta.dirname, '..')
const BASIC_CONFIG_PATH = resolve(CWD, 'src/basic/neemata.config.js')
const ALLOWLIST_CONFIG_PATH = resolve(
  CWD,
  'src/basic/neemata.cors-allowlist.config.js',
)
const CORS_TRUE_CONFIG_PATH = resolve(
  CWD,
  'src/basic/neemata.cors-true.config.js',
)
const SERVER_HOST = '127.0.0.1'
const SERVER_PORT = 4000
const SERVER_URL = `http://${SERVER_HOST}:${SERVER_PORT}`
const ALLOWED_ORIGIN = 'https://allowed-origin.test'
const DISALLOWED_ORIGIN = 'https://blocked-origin.test'

async function startServer(
  command: 'preview',
  options: { timeout?: number; configPath?: string } = {},
) {
  const timeout = options.timeout ?? 15000
  const canConnect = () =>
    new Promise<boolean>((resolve) => {
      const socket = connect({ host: SERVER_HOST, port: SERVER_PORT })
      const cleanup = () => {
        socket.removeAllListeners()
        socket.destroy()
      }

      socket.setTimeout(500)
      socket.once('connect', () => {
        cleanup()
        resolve(true)
      })
      socket.once('timeout', () => {
        cleanup()
        resolve(false)
      })
      socket.once('error', () => {
        cleanup()
        resolve(false)
      })
    })

  const args = ['exec', 'neemata', command]
  if (options.configPath) {
    args.push('--config', options.configPath)
  }

  const childEnv = { ...process.env, FORCE_COLOR: '0' }

  const serverProcess = spawn('pnpm', args, {
    cwd: CWD,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform === 'linux',
    env: childEnv,
  })

  serverProcess.stdout?.on('data', () => {})
  serverProcess.stderr?.on('data', () => {})

  await new Promise<void>((resolve, reject) => {
    let settled = false

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }

    const timeoutId = globalThis.setTimeout(() => {
      finish(new Error(`Server startup timeout (${command})`))
    }, timeout)

    const readinessInterval = globalThis.setInterval(() => {
      canConnect().then((ready) => {
        if (ready) finish()
      })
    }, 250)

    const onError = (err: Error) => finish(err)
    const onExit = (code: number | null) => {
      finish(new Error(`Server exited before readiness (code ${code})`))
    }

    const cleanup = () => {
      globalThis.clearTimeout(timeoutId)
      globalThis.clearInterval(readinessInterval)
      serverProcess.off('error', onError)
      serverProcess.off('exit', onExit)
    }

    serverProcess.on('error', onError)
    serverProcess.on('exit', onExit)
  })

  await setTimeout(1000)

  return serverProcess
}

async function stopServer(serverProcess: ChildProcess): Promise<void> {
  const killProcess = (signal: NodeJS.Signals) => {
    const pid = serverProcess.pid

    if (!pid) return

    if (process.platform === 'linux') {
      try {
        process.kill(-pid, signal)
        return
      } catch {
        // Fall through to direct process kill
      }
    }

    try {
      serverProcess.kill(signal)
    } catch {
      // Ignore if process already exited
    }
  }

  killProcess('SIGTERM')
  await new Promise<void>((resolve) => {
    serverProcess.on('exit', () => resolve())
    globalThis.setTimeout(() => {
      killProcess('SIGKILL')
      resolve()
    }, 5000)
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
      await stopServer(serverProcess)
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
      await stopServer(serverProcess)
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
      await stopServer(serverProcess)
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
