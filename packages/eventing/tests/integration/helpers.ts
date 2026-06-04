import { randomUUID } from 'node:crypto'

import { createLogger } from '@nmtjs/core'
import { Redis } from 'ioredis'
import { Redis as Valkey } from 'iovalkey'

import type { RedisStreamsEventingClient } from '../../src/redis-streams.ts'

export type EventingRedisServiceTarget = {
  name: string
  url: string | undefined
  createClient: () => RedisStreamsEventingClient
}

export const redisServiceTargets: EventingRedisServiceTarget[] = [
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

export const kafkaBrokers = process.env.KAFKA_BROKERS?.split(',')
  .map((broker) => broker.trim())
  .filter(Boolean)

export function requireRedisServiceEnv(target: EventingRedisServiceTarget) {
  if (!target.url && process.env.NMTJS_REQUIRE_SERVICE_TESTS === '1') {
    throw new Error(
      `${target.name} integration tests require ${envName(target)}`,
    )
  }
}

export function requireKafkaServiceEnv() {
  if (
    !kafkaBrokers?.length &&
    process.env.NMTJS_REQUIRE_SERVICE_TESTS === '1'
  ) {
    throw new Error('Kafka integration tests require KAFKA_BROKERS')
  }
}

export function createTestLogger(label: string) {
  return createLogger({ pinoOptions: { enabled: false } }, label)
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

function envName(target: EventingRedisServiceTarget) {
  return target.name === 'Redis' ? 'REDIS_URL' : 'VALKEY_URL'
}
