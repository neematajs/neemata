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
const SERVER_HOST = '127.0.0.1'
const SERVER_PORT = 4000
const SERVER_URL = `http://${SERVER_HOST}:${SERVER_PORT}`

async function startServer(command: 'preview', timeout = 15000) {
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

  const serverProcess = spawn('pnpm', [command], {
    cwd: CWD,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  })

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

    const checkReady = (data: Buffer) => {
      const output = data.toString()
      if (
        output.includes('started') ||
        output.includes('listening') ||
        output.includes('4000')
      ) {
        finish()
      }
    }

    const onError = (err: Error) => finish(err)
    const onExit = (code: number | null) => {
      if (code !== 0 && code !== null) {
        finish(new Error(`Server exited with code ${code}`))
      }
    }

    const cleanup = () => {
      globalThis.clearTimeout(timeoutId)
      globalThis.clearInterval(readinessInterval)
      serverProcess.stdout?.off('data', checkReady)
      serverProcess.stderr?.off('data', checkReady)
      serverProcess.off('error', onError)
      serverProcess.off('exit', onExit)
    }

    serverProcess.stdout?.on('data', checkReady)
    serverProcess.stderr?.on('data', checkReady)

    serverProcess.on('error', onError)
    serverProcess.on('exit', onExit)
  })

  await setTimeout(1000)

  return serverProcess
}

async function stopServer(serverProcess: ChildProcess): Promise<void> {
  serverProcess.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    serverProcess.on('exit', () => resolve())
    globalThis.setTimeout(() => {
      serverProcess.kill('SIGKILL')
      resolve()
    }, 5000)
  })
}

function createClient() {
  return new StaticClient(
    { contract, protocol: ProtocolVersion.v1, format: new JsonFormat() },
    HttpTransportFactory,
    { url: SERVER_URL },
  )
}

describe('Playground E2E - HTTP Streaming', { timeout: 30000 }, () => {
  let serverProcess: ChildProcess | null = null

  beforeAll(async () => {
    serverProcess = await startServer('preview')
  }, 20000)

  afterAll(async () => {
    if (serverProcess) {
      await stopServer(serverProcess)
    }
  })

  it('streams values over HTTP transport', async () => {
    const client = createClient()
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
