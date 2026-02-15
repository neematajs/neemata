import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
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

type JobKind = 'quick' | 'slow' | 'checkpoint' | 'hung'
type JobsBackend = 'redis' | 'valkey'

type JobProgress = {
  progress?: { tick?: number; index?: number; failed?: boolean }
}

type JobItem = {
  id: string
  status: string
  output?: Record<string, unknown> | null
  progress?: JobProgress
  error?: string
}

const contract = c.router({
  routes: {
    startQuickJob: c.procedure({
      input: t.object({ value: t.string() }),
      output: t.object({ id: t.string() }),
    }),
    startSlowJob: c.procedure({
      input: t.object({ ticks: t.number(), delayMs: t.number() }),
      output: t.object({ id: t.string() }),
    }),
    startCheckpointJob: c.procedure({
      input: t.object({ total: t.number(), failAt: t.number() }),
      output: t.object({ id: t.string() }),
    }),
    startHungJob: c.procedure({
      input: t.object({ durationMs: t.number() }),
      output: t.object({ id: t.string() }),
    }),
    getJob: c.procedure({
      input: t.object({ kind: t.string(), id: t.string() }),
      output: t.any(),
    }),
    cancelJob: c.procedure({
      input: t.object({ kind: t.string(), id: t.string() }),
      output: t.any(),
    }),
    retryJob: c.procedure({
      input: t.object({
        kind: t.string(),
        id: t.string(),
        clearState: t.boolean(),
      }),
      output: t.any(),
    }),
  },
})

const CWD = resolve(import.meta.dirname, '..')
const SERVER_HOST = '127.0.0.1'
const SERVER_PORT = 4000
const SERVER_URL = `ws://${SERVER_HOST}:${SERVER_PORT}`
const JOBS_BACKENDS = [
  'redis',
  'valkey',
] as const satisfies readonly JobsBackend[]

function getConfigPath(backend: JobsBackend) {
  return resolve(CWD, `src/jobs/neemata.jobs.${backend}.config.js`)
}

function createClient() {
  return new StaticClient(
    { contract, protocol: ProtocolVersion.v1, format: new JsonFormat() },
    WsTransportFactory,
    { url: SERVER_URL },
  )
}

async function startServer(
  command: 'preview',
  options: { timeout?: number; configPath: string },
) {
  const timeout = options.timeout ?? 20000

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

  const args = ['exec', 'neemata', command, '--config', options.configPath]

  const serverProcess = spawn('pnpm', args, {
    cwd: CWD,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform === 'linux',
    env: { ...process.env, FORCE_COLOR: '0' },
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

  await setTimeout(1200)

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

async function poll<T>(
  operation: () => Promise<T>,
  options: {
    timeoutMs?: number
    intervalMs?: number
    condition: (value: T) => boolean
    description: string
  },
) {
  const timeoutMs = options.timeoutMs ?? 20000
  const intervalMs = options.intervalMs ?? 200
  const startedAt = Date.now()
  let lastValue: T | undefined

  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await operation()
    if (options.condition(lastValue)) return lastValue
    await setTimeout(intervalMs)
  }

  throw new Error(
    `Timed out waiting for ${options.description}. Last value: ${JSON.stringify(lastValue)}`,
  )
}

async function getJob(
  client: ReturnType<typeof createClient>,
  kind: JobKind,
  id: string,
) {
  return (await client.call.getJob({ kind, id })) as JobItem | null
}

for (const backend of JOBS_BACKENDS) {
  describe(`Tests E2E - Jobs (${backend})`, { timeout: 60000 }, () => {
    let serverProcess: ChildProcess | null = null

    beforeAll(async () => {
      serverProcess = await startServer('preview', {
        configPath: getConfigPath(backend),
      })
    }, 30000)

    afterAll(async () => {
      if (serverProcess) {
        await stopServer(serverProcess)
      }
    })

    it('quick job completes successfully', async () => {
      const client = createClient()
      await client.connect()

      try {
        const queued = await client.call.startQuickJob({ value: 'quick-ok' })

        const completed = await poll(
          async () => getJob(client, 'quick', queued.id),
          {
            description: `quick job ${queued.id} to complete`,
            condition: (job) => job?.status === 'completed',
          },
        )

        expect(completed).not.toBeNull()
        expect(completed?.status).toBe('completed')
        expect(completed?.output).toEqual({ value: 'quick-ok' })
      } finally {
        await client.disconnect()
      }
    })

    it('slow job can be canceled and reaches failed status', async () => {
      const client = createClient()
      await client.connect()

      try {
        const queued = await client.call.startSlowJob({
          ticks: 80,
          delayMs: 60,
        })

        await poll(async () => getJob(client, 'slow', queued.id), {
          description: `slow job ${queued.id} to start`,
          condition: (job) =>
            job?.status === 'active' || job?.status === 'pending',
        })

        await client.call.cancelJob({ kind: 'slow', id: queued.id })

        const failed = await poll(
          async () => getJob(client, 'slow', queued.id),
          {
            description: `slow job ${queued.id} to fail after cancel`,
            condition: (job) => job?.status === 'failed',
          },
        )

        expect(failed).not.toBeNull()
        expect(failed?.status).toBe('failed')
        expect(failed?.error).toBeTypeOf('string')
        expect(failed?.error?.length).toBeGreaterThan(0)
      } finally {
        await client.disconnect()
      }
    })

    it('checkpoint job fails first, then retry clearState:false resumes and completes', async () => {
      const client = createClient()
      await client.connect()

      try {
        const total = 6
        const queued = await client.call.startCheckpointJob({
          total,
          failAt: 2,
        })

        const firstFailure = await poll(
          async () => getJob(client, 'checkpoint', queued.id),
          {
            description: `checkpoint job ${queued.id} first failure`,
            condition: (job) => job?.status === 'failed',
          },
        )

        expect(firstFailure?.status).toBe('failed')
        expect(firstFailure?.progress?.progress?.index).toBeGreaterThan(0)
        expect(firstFailure?.progress?.progress?.failed).toBe(true)

        await client.call.retryJob({
          kind: 'checkpoint',
          id: queued.id,
          clearState: false,
        })

        const completed = await poll(
          async () => getJob(client, 'checkpoint', queued.id),
          {
            description: `checkpoint job ${queued.id} completion after retry`,
            condition: (job) =>
              job?.status === 'completed' && job?.output !== null,
          },
        )

        expect(completed?.status).toBe('completed')
        expect(completed?.output).toEqual({ processed: total })
        expect(completed?.progress?.progress?.index).toBe(total)
      } finally {
        await client.disconnect()
      }
    })

    it('slow job persists progress (>0) before completion or cancel', async () => {
      const client = createClient()
      await client.connect()

      try {
        const queued = await client.call.startSlowJob({
          ticks: 40,
          delayMs: 80,
        })

        const jobWithProgress = await poll(
          async () => getJob(client, 'slow', queued.id),
          {
            description: `slow job ${queued.id} persisted progress > 0`,
            condition: (job) => {
              const tick = job?.progress?.progress?.tick
              return typeof tick === 'number' && tick > 0
            },
          },
        )

        expect(jobWithProgress?.progress?.progress?.tick).toBeGreaterThan(0)

        await client.call.cancelJob({ kind: 'slow', id: queued.id })

        await poll(async () => getJob(client, 'slow', queued.id), {
          description: `slow job ${queued.id} cancellation`,
          condition: (job) => job?.status === 'failed',
        })
      } finally {
        await client.disconnect()
      }
    })

    it('cancel on completed job is a no-op', async () => {
      const client = createClient()
      await client.connect()

      try {
        const queued = await client.call.startQuickJob({ value: 'done' })

        const completed = await poll(
          async () => getJob(client, 'quick', queued.id),
          {
            description: `quick job ${queued.id} completion for cancel no-op`,
            condition: (job) => job?.status === 'completed',
          },
        )

        expect(completed?.status).toBe('completed')

        await client.call.cancelJob({ kind: 'quick', id: queued.id })

        const afterCancel = await getJob(client, 'quick', queued.id)
        expect(afterCancel?.status).toBe('completed')
        expect(afterCancel?.output).toEqual({ value: 'done' })
      } finally {
        await client.disconnect()
      }
    })

    it('cancel request does not interrupt non-cooperative hung job mid-step', async () => {
      const client = createClient()
      await client.connect()

      try {
        const queued = await client.call.startHungJob({ durationMs: 4500 })

        await poll(async () => getJob(client, 'hung', queued.id), {
          description: `hung job ${queued.id} to become active`,
          condition: (job) =>
            job?.status === 'active' || job?.status === 'pending',
        })

        await client.call.cancelJob({ kind: 'hung', id: queued.id })

        const stillRunning = await poll(
          async () => getJob(client, 'hung', queued.id),
          {
            timeoutMs: 2000,
            intervalMs: 150,
            description: `hung job ${queued.id} remains active after cancel`,
            condition: (job) => job?.status === 'active',
          },
        )
        expect(stillRunning?.status).toBe('active')

        const completed = await poll(
          async () => getJob(client, 'hung', queued.id),
          {
            timeoutMs: 10000,
            description: `hung job ${queued.id} eventual completion`,
            condition: (job) => job?.status === 'completed',
          },
        )

        expect(completed?.status).toBe('completed')
        expect(completed?.output).toEqual({ done: true })
      } finally {
        await client.disconnect()
      }
    })

    it('invalid job kind rejects management operation', async () => {
      const client = createClient()
      await client.connect()

      try {
        await expect(
          client.call.getJob({ kind: 'unknown', id: 'missing' }),
        ).rejects.toBeDefined()
      } finally {
        await client.disconnect()
      }
    })
  })
}
