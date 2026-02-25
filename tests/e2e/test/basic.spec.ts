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
const BASIC_CONFIG_PATH = resolve(CWD, 'src/basic/neemata.config.js')
const PING_PROCEDURE_PATH = resolve(
  CWD,
  'src/basic/applications/main/procedures/ping.ts',
)
const APPLICATION_ENTRY_PATH = resolve(
  CWD,
  'src/basic/applications/main/index.ts',
)
const ROUTER_PATH = resolve(CWD, 'src/basic/applications/main/router.ts')
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
      const buildProcess = spawn(
        'pnpm',
        ['exec', 'neemata', 'build', '--config', BASIC_CONFIG_PATH],
        {
          cwd: CWD,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform === 'linux',
          env: { ...process.env, FORCE_COLOR: '0' },
        },
      )

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
      detached: process.platform === 'linux',
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

      const onError = (err: Error) => finish(err)
      const onExit = (code: number | null) => {
        if (code !== 0 && code !== null) {
          finish(new Error(`Server exited with code ${code}`))
        }
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

    await setTimeout(1500)

    return serverProcess
  }

  // For dev and preview commands
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
      if (code !== 0 && code !== null) {
        finish(new Error(`Server exited with code ${code}`))
      }
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

  // Give it a bit more time to fully initialize
  await setTimeout(1500)

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

function createClient(url: string) {
  return new StaticClient(
    { contract, protocol: ProtocolVersion.v1, format: new JsonFormat() },
    WsTransportFactory,
    { url },
  )
}

const SERVER_URL = `ws://${SERVER_HOST}:${SERVER_PORT}`

async function waitForPingMessage(
  client: ReturnType<typeof createClient>,
  expectedMessage: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? 15000
  const intervalMs = options.intervalMs ?? 250
  const startedAt = Date.now()
  let lastResult: unknown = null

  while (Date.now() - startedAt < timeoutMs) {
    lastResult = await client.call.ping({})
    if (
      typeof lastResult === 'object' &&
      lastResult !== null &&
      'message' in lastResult &&
      (lastResult as { message: string }).message === expectedMessage
    ) {
      return
    }

    await setTimeout(intervalMs)
  }

  throw new Error(
    `Timed out waiting for ping message '${expectedMessage}'. Last result: ${JSON.stringify(lastResult)}`,
  )
}

async function waitForPingResponsiveness(
  client: ReturnType<typeof createClient>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? 15000
  const intervalMs = options.intervalMs ?? 250
  const startedAt = Date.now()
  let lastError: unknown = null

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await client.call.ping({})
      if (
        typeof result === 'object' &&
        result !== null &&
        'message' in result &&
        typeof (result as { message: unknown }).message === 'string'
      ) {
        return
      }
    } catch (error) {
      lastError = error
    }

    await setTimeout(intervalMs)
  }

  throw new Error(
    `Timed out waiting for ping responsiveness. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

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
  let originalApplicationEntryContent: string | null = null
  let originalRouterContent: string | null = null
  let serverStdErr = ''
  let serverStdOut = ''

  beforeAll(async () => {
    // Save original file content for restoration
    originalPingContent = await readFile(PING_PROCEDURE_PATH, 'utf-8')
    originalApplicationEntryContent = await readFile(
      APPLICATION_ENTRY_PATH,
      'utf-8',
    )
    originalRouterContent = await readFile(ROUTER_PATH, 'utf-8')
    serverProcess = await startServer('dev', { timeout: 20000 })

    serverProcess.stderr?.on('data', (data) => {
      serverStdErr += data.toString()
    })

    serverProcess.stdout?.on('data', (data) => {
      serverStdOut += data.toString()
    })
  }, 25000)

  afterAll(async () => {
    // Restore original file content
    if (originalPingContent) {
      await writeFile(PING_PROCEDURE_PATH, originalPingContent, 'utf-8')
    }

    if (originalApplicationEntryContent) {
      await writeFile(
        APPLICATION_ENTRY_PATH,
        originalApplicationEntryContent,
        'utf-8',
      )
    }

    if (originalRouterContent) {
      await writeFile(ROUTER_PATH, originalRouterContent, 'utf-8')
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
          `'pong'`,
          `'pong-hmr'`,
        )
        await writeFile(PING_PROCEDURE_PATH, modifiedContent, 'utf-8')
        await waitForPingMessage(client, 'pong-hmr')
      } finally {
        try {
          await client.disconnect()
        } catch {
          // Ignore
        }
      }
    },
  )

  it('should survive rapid consecutive procedure changes in dev mode', async () => {
    const client = createClient(SERVER_URL)
    await client.connect()

    const cycleCount = 3
    const editsPerCycle = 12

    try {
      for (let cycle = 0; cycle < cycleCount; cycle++) {
        let lastExpectedMessage = 'pong'

        for (let editIndex = 0; editIndex < editsPerCycle; editIndex++) {
          lastExpectedMessage = `pong-hmr-stress-${cycle}-${editIndex}`
          const modifiedContent = originalPingContent!.replace(
            `'pong'`,
            `'${lastExpectedMessage}'`,
          )

          await writeFile(PING_PROCEDURE_PATH, modifiedContent, 'utf-8')
        }

        await waitForPingMessage(client, lastExpectedMessage, {
          timeoutMs: 20000,
          intervalMs: 150,
        })
      }

      expect(serverProcess?.exitCode).toBeNull()

      const combinedOutput = `${serverStdOut}\n${serverStdErr}`
      expect(combinedOutput).not.toContain('BroadcastChannel is closed')
      expect(combinedOutput).not.toContain('Unexpected Error')
    } finally {
      try {
        await writeFile(PING_PROCEDURE_PATH, originalPingContent!, 'utf-8')
        await waitForPingMessage(client, 'pong', {
          timeoutMs: 20000,
          intervalMs: 150,
        })
      } catch {
        // Ignore cleanup errors when server is already unstable
      }

      try {
        await client.disconnect()
      } catch {
        // Ignore
      }
    }
  })

  it('should survive rapid consecutive application-entry changes', async () => {
    const client = createClient(SERVER_URL)
    await client.connect()

    const cycleCount = 3
    const editsPerCycle = 10

    try {
      for (let cycle = 0; cycle < cycleCount; cycle++) {
        for (let editIndex = 0; editIndex < editsPerCycle; editIndex++) {
          const stamp = `hmr-entry-${cycle}-${editIndex}-${Date.now()}`
          const content = `${originalApplicationEntryContent!}\n\nexport const __hmrEntryStamp = '${stamp}'\n`

          await writeFile(APPLICATION_ENTRY_PATH, content, 'utf-8')
        }

        await waitForPingMessage(client, 'pong', {
          timeoutMs: 25000,
          intervalMs: 200,
        })

        expect(serverProcess?.exitCode).toBeNull()
      }

      const combinedOutput = `${serverStdOut}\n${serverStdErr}`
      expect(combinedOutput).not.toContain('BroadcastChannel is closed')
      expect(combinedOutput).not.toContain('Unexpected Error')
    } finally {
      try {
        await writeFile(
          APPLICATION_ENTRY_PATH,
          originalApplicationEntryContent!,
          'utf-8',
        )

        await waitForPingMessage(client, 'pong', {
          timeoutMs: 20000,
          intervalMs: 150,
        })
      } catch {
        // Ignore cleanup errors when server is already unstable
      }

      try {
        await client.disconnect()
      } catch {
        // Ignore
      }
    }
  })

  it('should survive extreme burst HMR churn across multiple files', async () => {
    const client = createClient(SERVER_URL)
    await client.connect()

    const cycles = 8
    const burstsPerCycle = 8

    try {
      for (let cycle = 0; cycle < cycles; cycle++) {
        for (let burstIndex = 0; burstIndex < burstsPerCycle; burstIndex++) {
          const stamp = `${cycle}-${burstIndex}-${Date.now()}`

          const pingContent = originalPingContent!.replace(
            `'pong'`,
            `'pong-burst-${cycle}-${burstIndex}'`,
          )

          const routerContent = `${originalRouterContent!}\n\nexport const __hmrRouterStamp = '${stamp}'\n`
          const entryContent = `${originalApplicationEntryContent!}\n\nexport const __hmrEntryBurstStamp = '${stamp}'\n`

          await Promise.all([
            writeFile(PING_PROCEDURE_PATH, pingContent, 'utf-8'),
            writeFile(ROUTER_PATH, routerContent, 'utf-8'),
            writeFile(APPLICATION_ENTRY_PATH, entryContent, 'utf-8'),
          ])
        }

        await waitForPingResponsiveness(client, {
          timeoutMs: 30000,
          intervalMs: 120,
        })

        expect(serverProcess?.exitCode).toBeNull()
      }

      const combinedOutput = `${serverStdOut}\n${serverStdErr}`
      expect(combinedOutput).not.toContain('BroadcastChannel is closed')
      expect(combinedOutput).not.toContain('Unexpected Error')
    } finally {
      try {
        await Promise.all([
          writeFile(PING_PROCEDURE_PATH, originalPingContent!, 'utf-8'),
          writeFile(
            APPLICATION_ENTRY_PATH,
            originalApplicationEntryContent!,
            'utf-8',
          ),
          writeFile(ROUTER_PATH, originalRouterContent!, 'utf-8'),
        ])

        await waitForPingMessage(client, 'pong', {
          timeoutMs: 30000,
          intervalMs: 150,
        })
      } catch {
        // Ignore cleanup errors when server is already unstable
      }

      try {
        await client.disconnect()
      } catch {
        // Ignore
      }
    }
  })
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
