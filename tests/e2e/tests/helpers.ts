import { randomUUID } from 'node:crypto'

import { createLogger } from '@nmtjs/core'

export const redisUrl = process.env.REDIS_URL
export const kafkaBrokers = process.env.KAFKA_BROKERS?.split(',')
  .map((broker) => broker.trim())
  .filter(Boolean)

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
