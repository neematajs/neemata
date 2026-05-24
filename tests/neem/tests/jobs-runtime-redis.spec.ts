import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { MessageChannel } from 'node:worker_threads'

import type { JobsWorkerRequest } from '@nmtjs/jobs/neem'
import type { NeemPluginContext, NeemPluginWorkerHandle } from '@nmtjs/neem'
import { createLogger } from '@nmtjs/core'
import { createJob, JobManager } from '@nmtjs/jobs'
import { defineJobs } from '@nmtjs/jobs/neem'
import { t } from '@nmtjs/type'
import { Redis } from 'ioredis'
import { afterEach, describe, expect, it } from 'vitest'

import { buildNeem } from '../../../packages/neem/src/internal/commands/build.ts'
import { startNeem } from '../../../packages/neem/src/internal/commands/start.ts'
import { createRuntimeJob } from '../fixtures/runtime-jobs.plugin.ts'

const runRedisTests = process.env.NMTJS_TEST_REDIS === '1'
const redisPort = Number(process.env.NMTJS_TEST_REDIS_PORT ?? 6379)
const fixturesDir = resolve(import.meta.dirname, '../fixtures')
const tempRoot = resolve(import.meta.dirname, '../node_modules/.tmp')
const tempDirs: string[] = []
const previousEventsFile = process.env.NEEM_RUNTIME_EVENTS_FILE
const previousJobName = process.env.NEEM_TEST_JOB_NAME

describe.runIf(runRedisTests)('@nmtjs/jobs Redis runtime', () => {
  afterEach(async () => {
    if (previousEventsFile === undefined) {
      delete process.env.NEEM_RUNTIME_EVENTS_FILE
    } else {
      process.env.NEEM_RUNTIME_EVENTS_FILE = previousEventsFile
    }
    if (previousJobName === undefined) {
      delete process.env.NEEM_TEST_JOB_NAME
    } else {
      process.env.NEEM_TEST_JOB_NAME = previousJobName
    }

    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    )
  })

  it('bridges queue workers to plugin-owned job runner workers', async () => {
    const events: unknown[] = []
    const client = () =>
      new Redis({
        host: '127.0.0.1',
        port: redisPort,
        maxRetriesPerRequest: null,
      })
    const job = createJob({
      name: `test-${Date.now()}`,
      pool: 'default',
      input: t.object({ value: t.string() }),
      output: t.object({ ok: t.boolean(), value: t.string() }),
    }).return(({ input }) => ({ ok: true, value: input.value }))
    const plugin = defineJobs({
      client,
      pools: { default: { threads: 1, jobs: 1 } },
      jobs: () => [job],
      hooks: () => ({
        updated(event) {
          events.push({ hook: 'updated', status: event.status })
        },
      }),
    })
    const context = createPluginContext()
    const managerClient = await client()
    const manager = new JobManager(managerClient, [job])

    await plugin.setup?.(context)
    await manager.initialize()

    try {
      const result = await manager.add(
        job,
        { value: 'hello' },
        { forceMissingWorkers: true, oneoff: true },
      )

      await expect(result.waitResult()).resolves.toEqual({
        ok: true,
        value: 'hello',
      })
      await waitFor(() =>
        events.some(
          (event) =>
            JSON.stringify(event) ===
            JSON.stringify({ hook: 'updated', status: 'completed' }),
        ),
      )
      expect(events).toContainEqual({ hook: 'updated', status: 'completed' })
    } finally {
      await manager.terminate()
      await managerClient.quit()
      await plugin.stop?.(context)
    }
  }, 20000)

  it('runs jobs through built Neem plugin worker artifact', async () => {
    await mkdir(tempRoot, { recursive: true })
    const outDir = await mkdtemp(resolve(tempRoot, 'neem-jobs-'))
    tempDirs.push(outDir)
    const eventsFile = resolve(outDir, 'events.jsonl')
    const jobName = `runtime-${Date.now()}`
    const client = () =>
      new Redis({
        host: '127.0.0.1',
        port: redisPort,
        maxRetriesPerRequest: null,
      })
    process.env.NEEM_RUNTIME_EVENTS_FILE = eventsFile
    process.env.NEEM_TEST_JOB_NAME = jobName

    const { manifest } = await buildNeem({
      config: resolve(fixturesDir, 'runtime-jobs.config.ts'),
      outDir,
    })
    expect(manifest.plugins[0]?.artifacts).toEqual([
      expect.objectContaining({
        id: 'job-runner',
        kind: 'worker',
        owner: { type: 'plugin', name: 'jobs', instanceId: 0 },
      }),
    ])

    const host = await startNeem({ outDir })
    const job = createRuntimeJob()
    const managerClient = await client()
    const manager = new JobManager(managerClient, [job])
    await manager.initialize()

    try {
      expect(host.getHealth()).toMatchObject({
        state: 'running',
        ready: true,
        apps: [],
        plugins: [
          {
            name: 'jobs',
            instanceId: 0,
            state: 'ready',
            workers: {
              count: 1,
              workers: [expect.objectContaining({ state: 'ready' })],
            },
          },
        ],
      })

      const result = await manager.add(
        job,
        { value: 'built-worker' },
        { forceMissingWorkers: true, oneoff: true },
      )

      await expect(result.waitResult()).resolves.toEqual({
        ok: true,
        value: 'built-worker',
      })
      await waitFor(async () =>
        (await readEvents(eventsFile)).some(
          (event) =>
            event.event === 'job-updated' && event.status === 'completed',
        ),
      )
    } finally {
      await manager.terminate()
      await managerClient.quit()
      await host.stop()
      await host.closed
    }
  }, 30000)
})

function createPluginContext(): NeemPluginContext {
  const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
  const workers = new Map<string, NeemPluginWorkerHandle>()

  return {
    mode: 'development',
    name: 'jobs',
    instanceId: 0,
    options: undefined,
    logger,
    artifacts: {
      resolve: () => ({
        id: 'entry',
        kind: 'module',
        owner: { type: 'plugin', name: 'jobs', instanceId: 0 },
        file: 'unused',
        outDir: 'unused',
      }),
      list: () => [],
    },
    workers: {
      async spawn(options) {
        const channel = new MessageChannel()
        channel.port2.on('message', (message: JobsWorkerRequest) => {
          if (message.type !== 'task') return
          const data = message.task.data as { value: string }
          channel.port2.postMessage({
            type: 'task',
            id: message.id,
            task: { type: 'success', result: { ok: true, value: data.value } },
          })
        })
        const handle: NeemPluginWorkerHandle = {
          id: options.id ?? options.name,
          name: options.name,
          artifactId:
            typeof options.artifact === 'string'
              ? options.artifact
              : options.artifact.id,
          port: channel.port1,
          getState: () => 'ready',
          async stop() {
            channel.port1.close()
            channel.port2.close()
          },
        }
        workers.set(handle.id, handle)
        return handle
      },
      async stop(id) {
        const worker = workers.get(id)
        if (!worker) return false
        await worker.stop()
        workers.delete(id)
        return true
      },
      list: () => [...workers.values()],
    },
    hooks: {
      hook: () => () => {},
      hookOnce: () => () => {},
      addHooks: () => () => {},
    },
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function readEvents(
  file: string,
): Promise<Array<{ event: string; status?: string }>> {
  const content = await readFile(file, 'utf8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  })
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; status?: string })
}
