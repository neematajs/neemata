import { appendFileSync } from 'node:fs'

import type { JobsLifecycleHooks } from '@nmtjs/jobs'
import { createJob } from '@nmtjs/jobs'
import { defineJobs } from '@nmtjs/jobs/neem'
import { t } from '@nmtjs/type'
import { Redis } from 'ioredis'

export function createRuntimeJob() {
  return createJob({
    name: process.env.NEEM_TEST_JOB_NAME ?? 'runtime-test-job',
    pool: 'default',
    input: t.object({ value: t.string() }),
    output: t.object({ ok: t.boolean(), value: t.string() }),
  }).return(({ input }) => ({ ok: true, value: input.value }))
}

function record(event: Record<string, unknown>) {
  const file = process.env.NEEM_RUNTIME_EVENTS_FILE
  if (!file) return
  appendFileSync(file, `${JSON.stringify(event)}\n`)
}

function createHooks(): JobsLifecycleHooks {
  return {
    added(event) {
      record({ event: 'job-added', id: event.id, status: event.status })
    },
    updated(event) {
      record({ event: 'job-updated', id: event.id, status: event.status })
    },
    removed(event) {
      record({ event: 'job-removed', id: event.id })
    },
  }
}

export default defineJobs({
  client: () =>
    new Redis({
      host: '127.0.0.1',
      port: Number(process.env.NMTJS_TEST_REDIS_PORT ?? 6379),
      maxRetriesPerRequest: null,
    }),
  pools: { default: { threads: 1, jobs: 1 } },
  jobs: () => [createRuntimeJob()],
  hooks: async () => createHooks(),
})
