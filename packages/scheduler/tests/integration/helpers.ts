import { randomUUID } from 'node:crypto'

import type { JobsClientInstance } from '@nmtjs/jobs'
import { createLogger } from '@nmtjs/core'
import { Redis } from 'ioredis'
import { Redis as Valkey } from 'iovalkey'

export type SchedulerServiceTarget = {
  name: string
  url: string | undefined
  createClient: () => JobsClientInstance
}

export const serviceTargets: SchedulerServiceTarget[] = [
  {
    name: 'Redis',
    url: process.env.REDIS_URL,
    createClient: () =>
      new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null }),
  },
  {
    name: 'Valkey',
    url: process.env.VALKEY_URL,
    createClient: () =>
      new Valkey(process.env.VALKEY_URL!, { maxRetriesPerRequest: null }),
  },
]

export function requireServiceEnv(target: SchedulerServiceTarget) {
  if (!target.url && process.env.NMTJS_REQUIRE_SERVICE_TESTS === '1') {
    throw new Error(
      `${target.name} integration tests require ${envName(target)}`,
    )
  }
}

export function createTestLogger(label: string) {
  return createLogger({ pinoOptions: { enabled: false } }, label)
}

export function createTestName(prefix: string) {
  return `${prefix}-${randomUUID()}`
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function envName(target: SchedulerServiceTarget) {
  return target.name === 'Redis' ? 'REDIS_URL' : 'VALKEY_URL'
}
