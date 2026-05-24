import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { JobManager } from '@nmtjs/jobs'
import { Redis } from 'ioredis'
import { afterEach, describe, expect, it } from 'vitest'

import { buildNeem } from '../../../packages/neem/src/internal/commands/build.ts'
import { startNeem } from '../../../packages/neem/src/internal/commands/start.ts'
import { createRuntimeJob } from '../fixtures/runtime-jobs.ts'

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

  it('runs jobs through built Neem runtime worker artifact', async () => {
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
    expect(manifest.runtimes?.jobs?.artifacts).toEqual([
      expect.objectContaining({
        id: 'job-runner',
        kind: 'worker',
        owner: { type: 'runtime', name: 'jobs' },
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
        runtimes: [
          {
            name: 'jobs',
            pool: { state: 'ready', size: 1, ready: 1 },
            threads: [
              expect.objectContaining({
                state: 'ready',
                artifact: expect.objectContaining({
                  id: 'job-runner',
                  owner: { type: 'runtime', name: 'jobs' },
                }),
              }),
            ],
          },
        ],
      })

      const result = await manager.add(job, { value: 'built-worker' })

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
