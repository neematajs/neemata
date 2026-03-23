import type { ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'

import { StaticClient } from '@nmtjs/client/static'
import { c } from '@nmtjs/contract'
import { JsonFormat } from '@nmtjs/json-format/client'
import { ProtocolVersion } from '@nmtjs/protocol'
import { t } from '@nmtjs/type'
import { WsTransportFactory } from '@nmtjs/ws-client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { poll } from './_utils/poll.ts'
import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  E2E_CWD,
  startNeemataCliServer,
  stopServerProcess,
} from './_utils/server.ts'

type JobsBackend = 'redis' | 'valkey'

type QuickJobItem = {
  id: string
  status: string
  output?: { value?: string } | null
}

type SlowJobItem = { id: string; status: string; error?: string }

type CheckpointJobItem = {
  id: string
  status: string
  output?: { processed?: number } | null
}

type JobsListResponse = {
  items: { id: string }[]
  page: number
  limit: number
  pages: number
  total: number
}

const contract = c.router({
  routes: {
    quick: c.router({
      routes: {
        info: c.procedure({ input: t.never(), output: t.any() }),
        list: c.procedure({
          input: t.object({
            page: t.number().optional(),
            limit: t.number().optional(),
            status: t.array(t.string()).optional(),
          }),
          output: t.any(),
        }),
        get: c.procedure({
          input: t.object({ id: t.string() }),
          output: t.any(),
        }),
        add: c.procedure({
          input: t.object({
            data: t.object({ value: t.string() }),
            jobId: t.string().optional(),
            priority: t.number().optional(),
            delay: t.number().optional(),
          }),
          output: t.object({ id: t.string(), name: t.string() }),
        }),
        retry: c.procedure({
          input: t.object({
            id: t.string(),
            clearState: t.boolean().optional(),
          }),
          output: t.never(),
        }),
        cancel: c.procedure({
          input: t.object({ id: t.string() }),
          output: t.never(),
        }),
        remove: c.procedure({
          input: t.object({ id: t.string() }),
          output: t.never(),
        }),
      },
    }),
    slow: c.router({
      routes: {
        add: c.procedure({
          input: t.object({
            data: t.object({ ticks: t.number(), delayMs: t.number() }),
            jobId: t.string().optional(),
            priority: t.number().optional(),
            delay: t.number().optional(),
          }),
          output: t.object({ id: t.string(), name: t.string() }),
        }),
        get: c.procedure({
          input: t.object({ id: t.string() }),
          output: t.any(),
        }),
        cancel: c.procedure({
          input: t.object({ id: t.string() }),
          output: t.never(),
        }),
      },
    }),
    checkpoint: c.router({
      routes: {
        add: c.procedure({
          input: t.object({
            data: t.object({ total: t.number(), failAt: t.number() }),
            jobId: t.string().optional(),
            priority: t.number().optional(),
            delay: t.number().optional(),
          }),
          output: t.object({ id: t.string(), name: t.string() }),
        }),
        get: c.procedure({
          input: t.object({ id: t.string() }),
          output: t.any(),
        }),
        retry: c.procedure({
          input: t.object({
            id: t.string(),
            clearState: t.boolean().optional(),
          }),
          output: t.never(),
        }),
      },
    }),
  },
})

const CWD = E2E_CWD
const SERVER_HOST = DEFAULT_SERVER_HOST
const SERVER_PORT = DEFAULT_SERVER_PORT
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

for (const backend of JOBS_BACKENDS) {
  describe(`Tests E2E - Jobs Router (${backend})`, { timeout: 60000 }, () => {
    let serverProcess: ChildProcess | null = null

    beforeAll(async () => {
      serverProcess = await startNeemataCliServer({
        command: 'preview',
        configPath: getConfigPath(backend),
        timeoutMs: 20000,
        startupDelayMs: 1200,
        cwd: CWD,
        host: SERVER_HOST,
        port: SERVER_PORT,
      })
    }, 30000)

    afterAll(async () => {
      if (serverProcess) {
        await stopServerProcess(serverProcess)
      }
    })

    it('supports info/add/get/list/remove for quick jobs via n.jobRouter', async () => {
      const client = createClient()
      await client.connect()

      try {
        const info = await client.call.quick.info(undefined)
        expect(info.name).toBe('playground-quick')
        expect(Array.isArray(info.steps)).toBe(true)
        expect(info.steps[0]).toMatchObject({
          conditional: false,
          parallel: false,
        })

        const added = await client.call.quick.add({
          data: { value: 'router-ok' },
        })
        expect(added.name).toBe('playground-quick')

        const completed = await poll(
          async () =>
            (await client.call.quick.get({
              id: added.id,
            })) as QuickJobItem | null,
          {
            description: `quick router job ${added.id} completion`,
            condition: (job) =>
              job?.status === 'completed' &&
              job?.output !== null &&
              job?.output?.value === 'router-ok',
          },
        )

        expect(completed?.status).toBe('completed')

        const listed = (await client.call.quick.list({
          page: 1,
          limit: 20,
        })) as JobsListResponse

        expect(listed.items.some((item) => item.id === added.id)).toBe(true)

        await client.call.quick.remove({ id: added.id })

        const removed = (await client.call.quick.get({
          id: added.id,
        })) as QuickJobItem | null
        expect(removed).toBeNull()
      } finally {
        await client.disconnect()
      }
    })

    it('supports cancel for active slow jobs via n.jobRouter', async () => {
      const client = createClient()
      await client.connect()

      try {
        const added = await client.call.slow.add({
          data: { ticks: 80, delayMs: 60 },
        })

        await poll(
          async () =>
            (await client.call.slow.get({
              id: added.id,
            })) as SlowJobItem | null,
          {
            description: `slow router job ${added.id} to become active or pending`,
            condition: (job) =>
              job?.status === 'active' || job?.status === 'pending',
          },
        )

        await client.call.slow.cancel({ id: added.id })

        const failed = await poll(
          async () =>
            (await client.call.slow.get({
              id: added.id,
            })) as SlowJobItem | null,
          {
            description: `slow router job ${added.id} to fail after cancel`,
            condition: (job) => job?.status === 'failed',
          },
        )

        expect(failed?.status).toBe('failed')
        expect(failed?.error).toBeTypeOf('string')
      } finally {
        await client.disconnect()
      }
    })

    it('supports retry for failed checkpoint jobs via n.jobRouter', async () => {
      const client = createClient()
      await client.connect()

      try {
        const added = await client.call.checkpoint.add({
          data: { total: 6, failAt: 2 },
        })

        const failed = await poll(
          async () =>
            (await client.call.checkpoint.get({
              id: added.id,
            })) as CheckpointJobItem | null,
          {
            description: `checkpoint router job ${added.id} to fail first`,
            condition: (job) => job?.status === 'failed',
          },
        )

        expect(failed?.status).toBe('failed')

        await client.call.checkpoint.retry({ id: added.id, clearState: false })

        const completed = await poll(
          async () =>
            (await client.call.checkpoint.get({
              id: added.id,
            })) as CheckpointJobItem | null,
          {
            description: `checkpoint router job ${added.id} completion after retry`,
            condition: (job) =>
              job?.status === 'completed' &&
              job?.output !== null &&
              job?.output?.processed === 6,
          },
        )

        expect(completed?.status).toBe('completed')
      } finally {
        await client.disconnect()
      }
    })
  })
}
