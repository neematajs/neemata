import { fileURLToPath } from 'node:url'
import { MessageChannel } from 'node:worker_threads'

import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import { afterEach, expect, it } from 'vitest'

import { Deadline, Lifetime } from '../../src/internal/lifetime.ts'
import { spawnWorker, WorkerRegistry } from '../../src/internal/transport.ts'
import { TestRpcs } from './fixtures/transport-protocol.ts'

const lifetimes: Lifetime[] = []
afterEach(async () => {
  await Promise.all(
    lifetimes
      .splice(0)
      .map((lifetime) =>
        Effect.runPromise(lifetime.close(Deadline.after(2_000))),
      ),
  )
})

async function worker(
  data: { mode?: string; delay?: number } = {},
  entry?: string,
) {
  const lifetime = Lifetime.make(2_000)
  lifetimes.push(lifetime)
  const failures: Error[] = []
  const registry = new WorkerRegistry()
  const spawned = await Effect.runPromise(
    spawnWorker(lifetime, {
      entry:
        entry ??
        fileURLToPath(
          new URL('./fixtures/transport.worker.ts', import.meta.url),
        ),
      workerData: data,
      env: process.env,
      group: TestRpcs,
      registry,
      label: 'Test worker',
      describeFatal: (fatal) => new Error(fatal.message),
      onFailure: (error) => failures.push(error),
      requestExit: (client, timeoutMs) =>
        client.stop({ timeoutMs }, { discard: true }),
    }),
  )
  return { ...spawned, lifetime, failures, registry }
}

it('delivers buffered RPC and transferred ports after a delayed ready handshake', async () => {
  const { client, registry, lifetime } = await worker({ delay: 250 })
  const channel = new MessageChannel()
  try {
    const received = new Promise((resolve) =>
      channel.port1.once('message', resolve),
    )
    await Effect.runPromise(client.port({ port: channel.port2 }))
    expect(await received).toBe('transferred')
    expect(await Effect.runPromise(client.ping())).toBe('pong')
    expect(
      await Effect.runPromise(lifetime.close(Deadline.after(2_000))),
    ).toEqual([])
    expect(registry.size).toBe(0)
  } finally {
    channel.port1.close()
    channel.port2.close()
  }
})

it('delivers a stop queued before readiness instead of interrupting its receive loop first', async () => {
  const { lifetime, registry, failures, exited } = await worker({ delay: 250 })
  expect(
    await Effect.runPromise(lifetime.close(Deadline.after(2_000))),
  ).toEqual([])
  expect(await Effect.runPromise(Deferred.await(exited))).toBe(0)
  expect(failures).toEqual([])
  expect(registry.size).toBe(0)
})

it.each(['exit-before-ready', 'fatal-before-ready'])(
  'fails a request when the worker has %s without respawning',
  async (mode) => {
    const { client, lifetime, failures, registry } = await worker({ mode })
    await expect(Effect.runPromise(client.ping())).rejects.toThrow()
    await expect(Effect.runPromise(client.ping())).rejects.toThrow()
    expect(failures).toHaveLength(1)
    expect(failures[0]?.message).toBe(
      mode === 'fatal-before-ready'
        ? 'fatal before exit'
        : 'Test worker exited with code [7]',
    )
    expect(
      await Effect.runPromise(lifetime.close(Deadline.after(2_000))),
    ).toEqual([])
    expect(registry.size).toBe(0)
  },
)

it('fails in-flight and subsequent requests when a serving worker exits', async () => {
  const { client, lifetime, failures, registry } = await worker()
  expect(await Effect.runPromise(client.ping())).toBe('pong')
  await expect(Effect.runPromise(client.crash())).rejects.toThrow()
  await expect(Effect.runPromise(client.ping())).rejects.toThrow()
  expect(failures).toHaveLength(1)
  expect(
    await Effect.runPromise(lifetime.close(Deadline.after(2_000))),
  ).toEqual([])
  expect(registry.size).toBe(0)
})

it('does not wait forever when the Node constructor rejects the entry', async () => {
  const { client, lifetime, failures, registry } = await worker(
    {},
    'not-an-absolute-worker-path',
  )
  await expect(Effect.runPromise(client.ping())).rejects.toThrow()
  expect(failures).toHaveLength(1)
  expect(
    await Effect.runPromise(lifetime.close(Deadline.after(2_000))),
  ).toEqual([])
  expect(registry.size).toBe(0)
})
