import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { StaticClient } from '@nmtjs/client/static'
import { c } from '@nmtjs/contract'
import { JsonFormat } from '@nmtjs/json-format/client'
import { ProtocolVersion } from '@nmtjs/protocol'
import { t } from '@nmtjs/type'
import { WsTransportFactory } from '@nmtjs/ws-client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Define the contract that matches our server's router
const contract = c.router({
  routes: {
    ping: c.procedure({
      input: t.object({}),
      output: t.object({ message: t.string() }),
    }),
  },
})

const SERVER_URL = 'ws://127.0.0.1:4000'
const STARTUP_TIMEOUT = 15000

describe('Playground E2E', () => {
  let serverProcess: ChildProcess | null = null

  beforeAll(async () => {
    // Start the server using neemata preview
    const cwd = resolve(import.meta.dirname, '..')

    serverProcess = spawn('pnpm', ['preview'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    })

    // Wait for server to be ready by checking output
    await new Promise<void>((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        reject(new Error('Server startup timeout'))
      }, STARTUP_TIMEOUT)

      const checkReady = (data: Buffer) => {
        const output = data.toString()
        // Look for indication that server is listening
        if (
          output.includes('started') ||
          output.includes('listening') ||
          output.includes('4000')
        ) {
          globalThis.clearTimeout(timeout)
          resolve()
        }
      }

      serverProcess!.stdout?.on('data', checkReady)
      serverProcess!.stderr?.on('data', (data) => {
        const output = data.toString()
        // Also check stderr for startup messages
        checkReady(data)
        // Log errors for debugging
        if (output.includes('ERROR') || output.includes('Error')) {
          console.error('Server error:', output)
        }
      })

      serverProcess!.on('error', (err) => {
        globalThis.clearTimeout(timeout)
        reject(err)
      })

      serverProcess!.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          globalThis.clearTimeout(timeout)
          reject(new Error(`Server exited with code ${code}`))
        }
      })
    })

    // Give it a bit more time to fully initialize
    await setTimeout(500)
  }, STARTUP_TIMEOUT + 5000)

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM')
      // Wait for graceful shutdown
      await new Promise<void>((resolve) => {
        serverProcess!.on('exit', () => resolve())
        globalThis.setTimeout(() => {
          serverProcess?.kill('SIGKILL')
          resolve()
        }, 5000)
      })
    }
  })

  it('should connect to the server and call ping procedure', async () => {
    const client = new StaticClient(
      { contract, protocol: ProtocolVersion.v1, format: new JsonFormat() },
      WsTransportFactory,
      { url: SERVER_URL },
    )

    await client.connect()

    try {
      const result = await client.call.ping({})
      expect(result).toEqual({ message: 'pong' })
    } finally {
      await client.disconnect()
    }
  })

  it('should handle multiple sequential calls', async () => {
    const client = new StaticClient(
      { contract, protocol: ProtocolVersion.v1, format: new JsonFormat() },
      WsTransportFactory,
      { url: SERVER_URL },
    )

    await client.connect()

    try {
      const results = await Promise.all([
        client.call.ping({}),
        client.call.ping({}),
        client.call.ping({}),
      ])

      for (const result of results) {
        expect(result).toEqual({ message: 'pong' })
      }
    } finally {
      await client.disconnect()
    }
  })

  it('should reconnect after disconnect', async () => {
    const client = new StaticClient(
      { contract, protocol: ProtocolVersion.v1, format: new JsonFormat() },
      WsTransportFactory,
      { url: SERVER_URL },
    )

    // First connection
    await client.connect()
    const result1 = await client.call.ping({})
    expect(result1).toEqual({ message: 'pong' })
    await client.disconnect()

    // Second connection
    await client.connect()
    const result2 = await client.call.ping({})
    expect(result2).toEqual({ message: 'pong' })
    await client.disconnect()
  })
})
