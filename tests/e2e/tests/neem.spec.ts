import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { StaticClient } from '@nmtjs/client/static'
import { c } from '@nmtjs/contract'
import { HttpTransportFactory } from '@nmtjs/http-client'
import { JsonFormat } from '@nmtjs/json-format/client'
import { ProtocolVersion } from '@nmtjs/protocol'
import { t } from '@nmtjs/type'
import { afterAll, describe, expect, it } from 'vitest'

import {
  DEFAULT_SERVER_HOST,
  E2E_CWD,
  stopServerProcess,
  waitForPortClosed,
  waitForPortReady,
} from './_utils/server.ts'

const NEEM_BIN_PATH = resolve(E2E_CWD, 'node_modules/@nmtjs/neem/bin/neem.js')
const NEEM_CONFIG_PATH = resolve(E2E_CWD, 'src/neem/neem.config.js')
const NODE_APP_ENTRY_PATH = resolve(E2E_CWD, 'src/neem/node.js')
const NODE_APP_DEPENDENCY_PATH = resolve(E2E_CWD, 'src/neem/node.dependency.js')

const NODE_APP_PORT = 4310
const NMTJS_APP_PORT = 4311

const nmtjsContract = c.router({
  routes: {
    ping: c.procedure({
      input: t.object({}),
      output: t.object({ message: t.string(), app: t.string() }),
    }),
  },
})

function createNmtjsClient() {
  return new StaticClient(
    {
      contract: nmtjsContract,
      protocol: ProtocolVersion.v1,
      format: new JsonFormat(),
    },
    HttpTransportFactory,
    { url: `http://${DEFAULT_SERVER_HOST}:${NMTJS_APP_PORT}` },
  )
}

async function waitForNmtjsMessage(
  expectedMessage: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
) {
  const { timeoutMs = 20000, intervalMs = 150 } = options
  const startedAt = Date.now()
  const client = createNmtjsClient()
  let lastMessage: string | undefined

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const payload = await client.call.ping({})
      lastMessage = payload.message

      if (payload.message === expectedMessage) {
        return payload
      }
    } catch {}

    await setTimeout(intervalMs)
  }

  throw new Error(
    `Timed out waiting for nmtjs message ${expectedMessage}, last seen ${lastMessage}`,
  )
}

async function fetchNodeAppResponse() {
  const response = await fetch(`http://${DEFAULT_SERVER_HOST}:${NODE_APP_PORT}`)

  if (response.status !== 200) {
    throw new Error(`Unexpected node app status: ${response.status}`)
  }

  return await response.json()
}

async function waitForNodeAppField(
  field: 'revision' | 'dependencyRevision',
  expectedValue: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
) {
  const { timeoutMs = 20000, intervalMs = 150 } = options
  const startedAt = Date.now()
  let lastValue: string | undefined

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const payload = await fetchNodeAppResponse()
      lastValue = payload[field]

      if (payload[field] === expectedValue) {
        return payload
      }
    } catch {}

    await setTimeout(intervalMs)
  }

  throw new Error(
    `Timed out waiting for node app ${field} ${expectedValue}, last seen ${lastValue}`,
  )
}

function getNodeFixtureField(source: string, field: string): string {
  const match = source.match(new RegExp(`${field}\\s*:\\s*'([^']+)'`))
  if (!match) {
    throw new Error(`Failed to detect node app ${field} in fixture source`)
  }

  return match[1]
}

function getDependencyFixtureRevision(source: string): string {
  const match = source.match(/nodeDependencyRevision\s*=\s*'([^']+)'/)
  if (!match) {
    throw new Error(
      'Failed to detect node dependency revision in fixture source',
    )
  }

  return match[1]
}

async function startNeemCliServer(
  command: 'dev' | 'start',
): Promise<ChildProcess> {
  const processHandle = spawn(
    'node',
    [NEEM_BIN_PATH, command, '--config', NEEM_CONFIG_PATH],
    {
      cwd: E2E_CWD,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform === 'linux',
      env: { ...process.env, FORCE_COLOR: '0' },
    },
  )

  await waitForPortReady({
    host: DEFAULT_SERVER_HOST,
    port: NODE_APP_PORT,
    timeoutMs: 20000,
  })

  await waitForPortReady({
    host: DEFAULT_SERVER_HOST,
    port: NMTJS_APP_PORT,
    timeoutMs: 20000,
  })

  await setTimeout(300)

  return processHandle
}

async function runNeemBuild(outDir: string): Promise<void> {
  await new Promise<void>((resolveBuild, rejectBuild) => {
    const buildProcess = spawn(
      'node',
      [
        NEEM_BIN_PATH,
        'build',
        '--config',
        NEEM_CONFIG_PATH,
        '--outDir',
        outDir,
      ],
      {
        cwd: E2E_CWD,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
      },
    )

    let output = ''
    buildProcess.stdout?.on('data', (data) => {
      output += data.toString()
    })
    buildProcess.stderr?.on('data', (data) => {
      output += data.toString()
    })

    buildProcess.on('error', rejectBuild)
    buildProcess.on('exit', (code) => {
      if (code === 0) {
        resolveBuild()
        return
      }

      rejectBuild(new Error(`Neem build failed with code ${code}\n${output}`))
    })
  })
}

async function startBuiltNeemServer(outDir: string): Promise<ChildProcess> {
  const serverEntrypoint = resolve(outDir, 'server/main.js')

  const processHandle = spawn('node', [serverEntrypoint], {
    cwd: E2E_CWD,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform === 'linux',
    env: { ...process.env, FORCE_COLOR: '0' },
  })

  await waitForPortReady({
    host: DEFAULT_SERVER_HOST,
    port: NODE_APP_PORT,
    timeoutMs: 20000,
  })

  await waitForPortReady({
    host: DEFAULT_SERVER_HOST,
    port: NMTJS_APP_PORT,
    timeoutMs: 20000,
  })

  await setTimeout(300)

  return processHandle
}

describe('Neem CLI E2E', { timeout: 60000 }, () => {
  it.each([
    ['dev', 'development'],
    ['start', 'production'],
  ] as const)('serves configured apps in %s mode', async (command, mode) => {
    const serverProcess = await startNeemCliServer(command)

    try {
      const nodeResponse = await fetch(
        `http://${DEFAULT_SERVER_HOST}:${NODE_APP_PORT}`,
      )

      expect(nodeResponse.status).toBe(200)
      expect(await nodeResponse.json()).toMatchObject({
        ok: true,
        app: 'node',
        mode,
        host: DEFAULT_SERVER_HOST,
        port: NODE_APP_PORT,
      })

      const nmtjsClient = createNmtjsClient()
      await expect(nmtjsClient.call.ping({})).resolves.toEqual({
        message: 'pong',
        app: 'nmtjs',
      })
    } finally {
      await stopServerProcess(serverProcess)
      await waitForPortClosed({
        host: DEFAULT_SERVER_HOST,
        port: NODE_APP_PORT,
        timeoutMs: 10000,
      })
      await waitForPortClosed({
        host: DEFAULT_SERVER_HOST,
        port: NMTJS_APP_PORT,
        timeoutMs: 10000,
      })
    }
  })

  const outDir = resolve(E2E_CWD, 'dist')

  it('builds application bundle artifacts', async () => {
    await rm(outDir, { recursive: true, force: true })

    await runNeemBuild(outDir)

    await access(resolve(outDir, 'server/main.js'))
    await access(resolve(outDir, 'server/thread.js'))
    await access(resolve(outDir, 'server/worker.js'))
    await access(resolve(outDir, 'applications/node'))
    await access(resolve(outDir, 'applications/nmtjs'))
  })

  it('boots built server artifacts', async () => {
    await rm(outDir, { recursive: true, force: true })

    await runNeemBuild(outDir)

    const serverProcess = await startBuiltNeemServer(outDir)

    try {
      await expect(fetchNodeAppResponse()).resolves.toMatchObject({
        ok: true,
        app: 'node',
        mode: 'production',
        host: DEFAULT_SERVER_HOST,
        port: NODE_APP_PORT,
      })

      await expect(waitForNmtjsMessage('pong')).resolves.toEqual({
        message: 'pong',
        app: 'nmtjs',
      })
    } finally {
      await stopServerProcess(serverProcess)
      await waitForPortClosed({
        host: DEFAULT_SERVER_HOST,
        port: NODE_APP_PORT,
        timeoutMs: 10000,
      })
      await waitForPortClosed({
        host: DEFAULT_SERVER_HOST,
        port: NMTJS_APP_PORT,
        timeoutMs: 10000,
      })
    }
  })

  it('hot reloads application definition changes in dev mode', {
    retry: 3,
  }, async () => {
    const originalNodeEntry = await readFile(NODE_APP_ENTRY_PATH, 'utf8')
    const initialRevision = getNodeFixtureField(originalNodeEntry, 'revision')
    const nextRevision =
      initialRevision === 'node-entry-v1' ? 'node-entry-v2' : 'node-entry-v1'
    const serverProcess = await startNeemCliServer('dev')

    try {
      await expect(
        waitForNodeAppField('revision', initialRevision),
      ).resolves.toMatchObject({
        app: 'node',
        mode: 'development',
        revision: initialRevision,
      })

      const updatedNodeEntry = originalNodeEntry.replace(
        `revision: '${initialRevision}'`,
        `revision: '${nextRevision}'`,
      )

      if (updatedNodeEntry === originalNodeEntry) {
        throw new Error(
          'Failed to update node app revision fixture for HMR test',
        )
      }

      await writeFile(NODE_APP_ENTRY_PATH, updatedNodeEntry, 'utf8')

      await expect(
        waitForNodeAppField('revision', nextRevision),
      ).resolves.toMatchObject({
        app: 'node',
        mode: 'development',
        revision: nextRevision,
      })
    } finally {
      await writeFile(NODE_APP_ENTRY_PATH, originalNodeEntry, 'utf8')

      await stopServerProcess(serverProcess)
      await waitForPortClosed({
        host: DEFAULT_SERVER_HOST,
        port: NODE_APP_PORT,
        timeoutMs: 10000,
      })
      await waitForPortClosed({
        host: DEFAULT_SERVER_HOST,
        port: NMTJS_APP_PORT,
        timeoutMs: 10000,
      })
    }
  })

  it('hot reloads imported dependency changes in dev mode', {
    retry: 3,
  }, async () => {
    const originalNodeEntry = await readFile(NODE_APP_ENTRY_PATH, 'utf8')
    const originalDependencyEntry = await readFile(
      NODE_APP_DEPENDENCY_PATH,
      'utf8',
    )
    const initialEntryRevision = getNodeFixtureField(
      originalNodeEntry,
      'revision',
    )
    const initialDependencyRevision = getDependencyFixtureRevision(
      originalDependencyEntry,
    )
    const nextDependencyRevision =
      initialDependencyRevision === 'node-dep-v1'
        ? 'node-dep-v2'
        : 'node-dep-v1'
    const serverProcess = await startNeemCliServer('dev')

    try {
      await expect(
        waitForNodeAppField('revision', initialEntryRevision),
      ).resolves.toMatchObject({
        app: 'node',
        mode: 'development',
        revision: initialEntryRevision,
      })

      await expect(
        waitForNodeAppField('dependencyRevision', initialDependencyRevision),
      ).resolves.toMatchObject({
        app: 'node',
        mode: 'development',
        dependencyRevision: initialDependencyRevision,
      })

      const updatedDependencyEntry = originalDependencyEntry.replace(
        `nodeDependencyRevision = '${initialDependencyRevision}'`,
        `nodeDependencyRevision = '${nextDependencyRevision}'`,
      )

      if (updatedDependencyEntry === originalDependencyEntry) {
        throw new Error(
          'Failed to update node app dependency revision fixture for HMR test',
        )
      }

      await writeFile(NODE_APP_DEPENDENCY_PATH, updatedDependencyEntry, 'utf8')

      await expect(
        waitForNodeAppField('dependencyRevision', nextDependencyRevision),
      ).resolves.toMatchObject({
        app: 'node',
        mode: 'development',
        revision: initialEntryRevision,
        dependencyRevision: nextDependencyRevision,
      })
    } finally {
      await writeFile(NODE_APP_DEPENDENCY_PATH, originalDependencyEntry, 'utf8')

      await stopServerProcess(serverProcess)
      await waitForPortClosed({
        host: DEFAULT_SERVER_HOST,
        port: NODE_APP_PORT,
        timeoutMs: 10000,
      })
      await waitForPortClosed({
        host: DEFAULT_SERVER_HOST,
        port: NMTJS_APP_PORT,
        timeoutMs: 10000,
      })
    }
  })

  it('keeps other applications healthy during app-specific HMR', {
    retry: 3,
  }, async () => {
    const originalDependencyEntry = await readFile(
      NODE_APP_DEPENDENCY_PATH,
      'utf8',
    )
    const initialDependencyRevision = getDependencyFixtureRevision(
      originalDependencyEntry,
    )
    const nextDependencyRevision =
      initialDependencyRevision === 'node-dep-v1'
        ? 'node-dep-v2'
        : 'node-dep-v1'
    const serverProcess = await startNeemCliServer('dev')

    try {
      await expect(
        waitForNodeAppField('dependencyRevision', initialDependencyRevision),
      ).resolves.toMatchObject({
        app: 'node',
        mode: 'development',
        dependencyRevision: initialDependencyRevision,
      })

      await expect(waitForNmtjsMessage('pong')).resolves.toEqual({
        message: 'pong',
        app: 'nmtjs',
      })

      const updatedDependencyEntry = originalDependencyEntry.replace(
        `nodeDependencyRevision = '${initialDependencyRevision}'`,
        `nodeDependencyRevision = '${nextDependencyRevision}'`,
      )

      if (updatedDependencyEntry === originalDependencyEntry) {
        throw new Error(
          'Failed to update node app dependency revision fixture for multi-app HMR test',
        )
      }

      await writeFile(NODE_APP_DEPENDENCY_PATH, updatedDependencyEntry, 'utf8')

      await expect(
        waitForNodeAppField('dependencyRevision', nextDependencyRevision),
      ).resolves.toMatchObject({
        app: 'node',
        mode: 'development',
        dependencyRevision: nextDependencyRevision,
      })

      await expect(waitForNmtjsMessage('pong')).resolves.toEqual({
        message: 'pong',
        app: 'nmtjs',
      })
    } finally {
      await writeFile(NODE_APP_DEPENDENCY_PATH, originalDependencyEntry, 'utf8')

      await stopServerProcess(serverProcess)
      await waitForPortClosed({
        host: DEFAULT_SERVER_HOST,
        port: NODE_APP_PORT,
        timeoutMs: 10000,
      })
      await waitForPortClosed({
        host: DEFAULT_SERVER_HOST,
        port: NMTJS_APP_PORT,
        timeoutMs: 10000,
      })
    }
  })

  afterAll(async () => {
    // await rm(outDir, { recursive: true, force: true })
  })
})
