import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { StaticClient } from '@nmtjs/client/static'
import { c } from '@nmtjs/contract'
import { JsonFormat } from '@nmtjs/json-format/client'
import { MsgpackFormat } from '@nmtjs/msgpack-format/client'
import { ProtocolVersion } from '@nmtjs/protocol'
import { t } from '@nmtjs/type'
import { WsTransportFactory } from '@nmtjs/ws-client'
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
const SERVER_HOST = '127.0.0.1'
const SERVER_PORT = 4000
const SERVER_URL = `ws://${SERVER_HOST}:${SERVER_PORT}`

async function startServer(
  command: 'preview',
  options: { timeout?: number } = {},
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

  const serverProcess = spawn(
    'pnpm',
    ['exec', 'neemata', command, '--config', BASIC_CONFIG_PATH],
    {
      cwd: CWD,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform === 'linux',
      env: { ...process.env, FORCE_COLOR: '0' },
    },
  )

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

function createWsClient(format: JsonFormat | MsgpackFormat) {
  return new StaticClient(
    { contract, protocol: ProtocolVersion.v1, format },
    WsTransportFactory,
    { url: SERVER_URL },
  )
}

describe('Playground E2E - WebSocket Streaming', { timeout: 30000 }, () => {
  let serverProcess: ChildProcess | null = null

  beforeAll(async () => {
    serverProcess = await startServer('preview')
  }, 20000)

  afterAll(async () => {
    if (serverProcess) {
      await stopServer(serverProcess)
    }
  })

  it('streams values over WebSocket transport with JSON format', async () => {
    const client = createWsClient(new JsonFormat())
    const result: number[] = []

    await client.connect()
    try {
      for await (const chunk of await client.stream.streamCount({ count: 5 })) {
        result.push(chunk.index)
      }
    } finally {
      await client.disconnect()
    }

    expect(result).toEqual([0, 1, 2, 3, 4])
  })

  it('streams values over WebSocket transport with Msgpack format', async () => {
    const client = createWsClient(new MsgpackFormat())
    const result: number[] = []

    await client.connect()
    try {
      for await (const chunk of await client.stream.streamCount({ count: 5 })) {
        result.push(chunk.index)
      }
    } finally {
      await client.disconnect()
    }

    expect(result).toEqual([0, 1, 2, 3, 4])
  })
})
