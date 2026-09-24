import { randomUUID } from 'node:crypto'

import { Redis } from 'ioredis'
import { Redis as Valkey } from 'iovalkey'

import type { RedisPubSubClient } from '../../src/redis.ts'
import type { PubSubLogger } from '../../src/utils.ts'

export type PubSubServiceTarget = {
  name: string
  url: string | undefined
  createClient: (options?: { commandTimeout?: number }) => RedisPubSubClient
}

export const serviceTargets: PubSubServiceTarget[] = [
  {
    name: 'Redis',
    url: process.env.REDIS_URL,
    createClient: (options) =>
      new Redis(process.env.REDIS_URL!, {
        maxRetriesPerRequest: null,
        ...options,
      }),
  },
  {
    name: 'Valkey',
    url: process.env.VALKEY_URL,
    createClient: (options) =>
      new Valkey(process.env.VALKEY_URL!, {
        maxRetriesPerRequest: null,
        ...options,
      }),
  },
]

export function requireServiceEnv(target: PubSubServiceTarget) {
  if (!target.url && process.env.NMTJS_REQUIRE_SERVICE_TESTS === '1') {
    throw new Error(
      `${target.name} integration tests require ${envName(target)}`,
    )
  }
}

export function createTestLogger(_label: string): PubSubLogger {
  return { trace() {}, debug() {}, warn() {}, error() {} }
}

export function createTestName(prefix: string) {
  return `${prefix}-${randomUUID()}`
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for condition')
}

function envName(target: PubSubServiceTarget) {
  return target.name === 'Redis' ? 'REDIS_URL' : 'VALKEY_URL'
}
