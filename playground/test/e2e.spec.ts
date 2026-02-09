import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
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

const CWD = resolve(import.meta.dirname, '..')
const PING_PROCEDURE_PATH = resolve(
  CWD,
  'src/applications/main/procedures/ping.ts',
)
const SERVER_HOST = '127.0.0.1'
const SERVER_PORT = 4000

async function startServer(
  command: 'dev' | 'preview' | 'build',
  options: { timeout?: number } = {},
): Promise<ChildProcess> {
  const { timeout = 15000 } = options

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

  // If build command, run build first then start the built server
  if (command === 'build') {
    await new Promise<void>((resolve, reject) => {
      const buildProcess = spawn('pnpm', ['build'], {
        cwd: CWD,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
      })

      let buildOutput = ''
      buildProcess.stdout?.on('data', (data) => {
        buildOutput += data.toString()
      })
      buildProcess.stderr?.on('data', (data) => {
        buildOutput += data.toString()
      })

      buildProcess.on('error', reject)
      buildProcess.on('exit', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`Build failed with code ${code}\n${buildOutput}`))
        }
      })
    })

    // Start the built server
    const serverProcess = spawn('node', ['dist/main.js'], {
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
        finish(new Error('Server startup timeout (build)'))
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
      serverProcess.stderr?.on('data', (data) => {
        checkReady(data)
        const output = data.toString()
        if (output.includes('ERROR') || output.includes('Error')) {
          console.error('Server error:', output)
        }
      })

      serverProcess.on('error', onError)
      serverProcess.on('exit', onExit)
    })

    await setTimeout(1500)

    return serverProcess
  }

  // For dev and preview commands
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
    serverProcess.stderr?.on('data', (data) => {
      checkReady(data)
      const output = data.toString()
      if (output.includes('ERROR') || output.includes('Error')) {
        console.error('Server error:', output)
      }
    })

    serverProcess.on('error', onError)
    serverProcess.on('exit', onExit)
  })

  // Give it a bit more time to fully initialize
  await setTimeout(1500)

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

function createClient(url: string) {
  return new StaticClient(
    { contract, protocol: ProtocolVersion.v1, format: new JsonFormat() },
    WsTransportFactory,
    { url },
  )
}

const SERVER_URL = `ws://${SERVER_HOST}:${SERVER_PORT}`

describe(
  'Playground E2E - Preview Mode',
  { timeout: 30000, concurrent: false },
  () => {
    let serverProcess: ChildProcess | null = null

    beforeAll(async () => {
      serverProcess = await startServer('preview')
    }, 20000)

    afterAll(async () => {
      if (serverProcess) {
        await stopServer(serverProcess)
      }
    })

    it('should connect to the server and call ping procedure', async () => {
      const client = createClient(SERVER_URL)

      await client.connect()

      try {
        const result = await client.call.ping({})
        expect(result).toEqual({ message: 'pong' })
      } finally {
        await client.disconnect()
      }
    })

    it('should handle multiple sequential calls', async () => {
      const client = createClient(SERVER_URL)

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
      const client = createClient(SERVER_URL)

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
  },
)

describe('Playground E2E - Dev Mode', { timeout: 60000 }, () => {
  let serverProcess: ChildProcess | null = null
  let originalPingContent: string | null = null

  beforeAll(async () => {
    // Save original file content for restoration
    originalPingContent = await readFile(PING_PROCEDURE_PATH, 'utf-8')
    serverProcess = await startServer('dev', { timeout: 20000 })
  }, 25000)

  afterAll(async () => {
    // Restore original file content
    if (originalPingContent) {
      await writeFile(PING_PROCEDURE_PATH, originalPingContent, 'utf-8')
    }

    if (serverProcess) {
      await stopServer(serverProcess)
    }
  })

  it('should connect and call ping in dev mode', async () => {
    const client = createClient(SERVER_URL)

    await client.connect()

    try {
      const result = await client.call.ping({})
      expect(result).toEqual({ message: 'pong' })
    } finally {
      await client.disconnect()
    }
  })

  it(
    'should hot reload when procedure file changes',
    { retry: 3 },
    async () => {
      const client = createClient(SERVER_URL)

      await client.connect()

      try {
        // Initial call should return 'pong'
        const result1 = await client.call.ping({})
        expect(result1).toEqual({ message: 'pong' })

        // Modify the procedure file to return a different message
        const modifiedContent = originalPingContent!.replace(
          `{ message: 'pong' }`,
          `{ message: 'pong-hmr' }`,
        )
        await writeFile(PING_PROCEDURE_PATH, modifiedContent, 'utf-8')
        await setTimeout(1000)
        const result2 = await client.call.ping({})
        expect(result2).toEqual({ message: 'pong-hmr' })
      } finally {
        try {
          await client.disconnect()
        } catch {
          // Ignore
        }
      }
    },
  )
})

describe(
  'Playground E2E - Production Build',
  { timeout: 45000, concurrent: false },
  () => {
    let serverProcess: ChildProcess | null = null

    beforeAll(async () => {
      serverProcess = await startServer('build', { timeout: 25000 })
    }, 30000)

    afterAll(async () => {
      if (serverProcess) {
        await stopServer(serverProcess)
      }
    })

    it('should connect to the built server and call ping procedure', async () => {
      const client = createClient(SERVER_URL)

      await client.connect()

      try {
        const result = await client.call.ping({})
        expect(result).toEqual({ message: 'pong' })
      } finally {
        await client.disconnect()
      }
    })

    it('should handle multiple sequential calls on built server', async () => {
      const client = createClient(SERVER_URL)

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

    it('should reconnect after disconnect on built server', async () => {
      const client = createClient(SERVER_URL)

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
  },
)
