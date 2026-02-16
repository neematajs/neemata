import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { StaticClient } from '@nmtjs/client/static'
import { c } from '@nmtjs/contract'
import { JsonFormat } from '@nmtjs/json-format/client'
import { ProtocolVersion } from '@nmtjs/protocol'
import { t } from '@nmtjs/type'
import { WsTransportFactory } from '@nmtjs/ws-client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  E2E_CWD,
  startNeemataCliServer,
  stopServerProcess,
  waitForPortReady,
} from './_utils/server.ts'

// Define the contract that matches our server's router
const contract = c.router({
  routes: {
    ping: c.procedure({
      input: t.object({}),
      output: t.object({ message: t.string() }),
    }),
  },
})

const CWD = E2E_CWD
const BASIC_CONFIG_PATH = resolve(CWD, 'src/basic/neemata.config.js')
const PING_PROCEDURE_PATH = resolve(
  CWD,
  'src/basic/applications/main/procedures/ping.ts',
)
const SERVER_HOST = DEFAULT_SERVER_HOST
const SERVER_PORT = DEFAULT_SERVER_PORT

async function startServer(
  command: 'dev' | 'preview' | 'build',
  options: { timeout?: number } = {},
): Promise<ChildProcess> {
  const { timeout = 15000 } = options

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

    await waitForPortReady({
      host: SERVER_HOST,
      port: SERVER_PORT,
      timeoutMs: timeout,
    })

    await setTimeout(1500)

    return serverProcess
  }

  return await startNeemataCliServer({
    command,
    cwd: CWD,
    configPath: BASIC_CONFIG_PATH,
    timeoutMs: timeout,
    startupDelayMs: 1500,
    host: SERVER_HOST,
    port: SERVER_PORT,
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
        await stopServerProcess(serverProcess)
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
      await stopServerProcess(serverProcess)
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
        await stopServerProcess(serverProcess)
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
