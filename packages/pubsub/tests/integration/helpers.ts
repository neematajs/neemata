import { randomUUID } from 'node:crypto'
import net from 'node:net'

import { Redis } from 'ioredis'
import { Redis as Valkey } from 'iovalkey'

import type { RedisPubSubClient } from '../../src/redis.ts'
import type { PubSubLogger } from '../../src/utils.ts'

export type PubSubServiceTarget = {
  name: string
  url: string | undefined
  createClient: (options?: {
    commandTimeout?: number
    url?: string
  }) => RedisPubSubClient
}

export const serviceTargets: PubSubServiceTarget[] = [
  {
    name: 'Redis',
    url: process.env.REDIS_URL,
    createClient: ({ url = process.env.REDIS_URL!, ...options } = {}) =>
      new Redis(url, { maxRetriesPerRequest: null, ...options }),
  },
  {
    name: 'Valkey',
    url: process.env.VALKEY_URL,
    createClient: ({ url = process.env.VALKEY_URL!, ...options } = {}) =>
      new Valkey(url, { maxRetriesPerRequest: null, ...options }),
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

export type TrafficGate = Awaited<ReturnType<typeof createTrafficGate>>

// Forwards connections to the broker and can hold client-to-broker traffic,
// so a test controls when a command reaches the broker without pausing the
// broker for every other client sharing it.
export async function createTrafficGate(serviceUrl: string) {
  const upstream = new URL(serviceUrl)
  const sockets = new Set<net.Socket>()
  const flushes = new Set<() => void>()
  let holding = false
  let received = ''

  const server = net.createServer((client) => {
    const broker = net.connect(Number(upstream.port || 6379), upstream.hostname)
    for (const socket of [client, broker]) {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.on('close', () => {
        sockets.delete(socket)
        client.destroy()
        broker.destroy()
      })
    }
    const pending: Buffer[] = []
    const flush = () => {
      for (const chunk of pending.splice(0)) broker.write(chunk)
    }
    flushes.add(flush)
    client.on('close', () => flushes.delete(flush))
    client.on('data', (chunk) => {
      if (holding) pending.push(chunk)
      else broker.write(chunk)
    })
    broker.on('data', (chunk) => {
      received += chunk.toString()
      client.write(chunk)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as net.AddressInfo
  const url = new URL(serviceUrl)
  url.hostname = '127.0.0.1'
  url.port = String(port)

  return {
    url: url.toString(),
    /** Stops forwarding client traffic to the broker until `release`. */
    hold() {
      holding = true
    },
    release() {
      holding = false
      for (const flush of flushes) flush()
    },
    /** Everything the broker has sent back to clients, as text. */
    received: () => received,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function envName(target: PubSubServiceTarget) {
  return target.name === 'Redis' ? 'REDIS_URL' : 'VALKEY_URL'
}
