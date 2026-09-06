import { randomUUID } from 'node:crypto'

import { t } from '@nmtjs/type'
import { Redis } from 'ioredis'
import { Redis as Valkey } from 'iovalkey'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkflowRedisClient } from '../../src/adapters/redis.ts'
import { createRedisWorkflowRuntime } from '../../src/adapters/redis.ts'
import {
  defineTask,
  defineWorkflow,
  implementWorkflow,
} from '../../src/index.ts'
import {
  createWorkflowRuntimeClient,
  runWorkflowWorker,
} from '../../src/runtime/index.ts'
import { createTestContainer } from './helpers.ts'

const targets = [
  { name: 'Redis', url: process.env.REDIS_URL, Client: Redis },
  { name: 'Valkey', url: process.env.VALKEY_URL, Client: Valkey },
]

const payload = {
  empty: [],
  nested: [{ empty: [], createdAt: 'literal', completedAt: '2026-01-01' }],
  integer: Number.MAX_SAFE_INTEGER,
  fraction: 0.12345678901234566,
  createdAt: 'not a timestamp',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

for (const target of targets) {
  describe.skipIf(!target.url)(
    `Redis store regressions against ${target.name}`,
    () => {
      const cleanup: Array<() => Promise<void>> = []

      afterEach(async () => {
        vi.restoreAllMocks()
        vi.useRealTimers()
        for (const dispose of cleanup.splice(0)) await dispose()
      })

      const createHarness = (terminalRetentionMs = 5_000) => {
        const client: WorkflowRedisClient = new target.Client(target.url!, {
          maxRetriesPerRequest: 1,
          commandTimeout: 2_000,
        })
        const keyPrefix = `nmtjs:test:store-regression:${randomUUID()}:`
        const runtime = createRedisWorkflowRuntime({
          client,
          keyPrefix,
          terminalRetentionMs,
        })
        cleanup.push(async () => {
          await runtime.dispose?.()
          let cursor = '0'
          do {
            const [next, keys] = await client.scan(
              cursor,
              'MATCH',
              `${keyPrefix}*`,
              'COUNT',
              100,
            )
            cursor = next
            if (keys.length > 0) await client.del(...keys)
          } while (cursor !== '0')
          await client.quit()
        })
        return { client, keyPrefix, runtime }
      }

      it('preserves application JSON and stores metadata as Unix milliseconds', async () => {
        const { client, keyPrefix, runtime } = createHarness()
        const input = {
          workflowName: 'json',
          input: payload,
          tags: { createdAt: 'tag' },
          idempotencyKey: ['json', payload],
        }
        const run = await runtime.store.createRun(input)
        expect(run.input).toStrictEqual(payload)
        expect(run.tags).toStrictEqual(input.tags)
        expect(run.createdAt).toBeInstanceOf(Date)
        const running = await runtime.store.markRunRunning({ runId: run.id })
        expect(running?.input).toStrictEqual(payload)
        const replay = await runtime.store.createRun(input)
        expect(replay.id).toBe(run.id)
        const completed = await runtime.store.completeRun({
          runId: run.id,
          output: payload,
        })
        expect(completed?.input).toStrictEqual(payload)
        expect(completed?.output).toStrictEqual(payload)
        const raw = await client.hget(
          `${keyPrefix}family:${run.id}:runs`,
          run.id,
        )
        const stored = JSON.parse(raw!) as Record<string, unknown>
        expect(typeof stored.createdAt).toBe('number')
        expect(typeof stored.updatedAt).toBe('number')
        expect(stored.input).toBe(JSON.stringify(payload))
      })

      it('preserves node, child and attempt payloads across state transitions', async () => {
        const { runtime } = createHarness()
        const run = await runtime.store.createRun({
          workflowName: 'attempt-json',
          input: null,
        })
        await runtime.store.createNode({
          runId: run.id,
          name: 'step',
          kind: 'activity',
        })
        await runtime.store.setNodeInput({
          runId: run.id,
          nodeName: 'step',
          input: payload,
        })
        await runtime.store.ensureNodeChildren({
          runId: run.id,
          nodeName: 'step',
          children: [{ childKey: 'one', kind: 'activity', item: payload }],
        })
        const { attempt } = await runtime.store.ensureChildAttempt({
          runId: run.id,
          nodeName: 'step',
          childKey: 'one',
          input: payload,
          idempotencyKey: ['attempt', payload],
        })
        expect(attempt.input).toStrictEqual(payload)
        await runtime.store.completeCurrentAttempt({
          attemptId: attempt.id,
          leaseToken: attempt.leaseToken!,
          output: payload,
        })
        await runtime.store.completeNode({
          runId: run.id,
          nodeName: 'step',
          output: [],
        })
        const snapshot = await runtime.store.loadRunSnapshot(run.id)
        expect(snapshot?.nodes[0]?.input).toStrictEqual(payload)
        expect(snapshot?.nodes[0]?.output).toStrictEqual([])
        expect(snapshot?.children[0]?.item).toStrictEqual(payload)
        expect(snapshot?.children[0]?.output).toStrictEqual(payload)
        expect(snapshot?.attempts[0]?.output).toStrictEqual(payload)
        expect(snapshot?.attempts[0]?.completedAt).toBeInstanceOf(Date)
      })

      it('keeps empty child indexes and empty cancellation results as arrays', async () => {
        const { runtime } = createHarness()
        const run = await runtime.store.createRun({
          workflowName: 'empty-map',
          input: null,
        })
        await expect(
          runtime.store.cancelNonTerminalRunNodes({ runId: run.id }),
        ).resolves.toStrictEqual([])
        await runtime.store.createNode({
          runId: run.id,
          name: 'items',
          kind: 'mapTask',
        })
        const input = { runId: run.id, nodeName: 'items', children: [] }
        await expect(
          runtime.store.ensureNodeChildren(input),
        ).resolves.toStrictEqual({ children: [], created: true })
        await expect(
          runtime.store.ensureNodeChildren(input),
        ).resolves.toStrictEqual({ children: [], created: false })
        await expect(
          runtime.store.loadRunSnapshot(run.id),
        ).resolves.toMatchObject({ children: [], attempts: [] })
      })

      it('completes an empty map through the public workflow worker', async () => {
        const { runtime } = createHarness()
        const task = defineTask({
          name: 'map-item',
          input: t.string(),
          output: t.string(),
        })
        const workflow = defineWorkflow({
          name: 'empty-map-worker',
          input: t.object({ items: t.array(t.string()) }),
          output: t.number(),
        })
          .mapTask('items', task, { item: t.string() })
          .build()
        const implementation = implementWorkflow(workflow)
          .items(task, {
            items: (_ctx, _outputs, input) => input.items,
            input: (_ctx, _outputs, item) => item,
          })
          .finish((_ctx, { items }) => items.items.length)
        const client = createWorkflowRuntimeClient(runtime)
        const run = await client.start(workflow, { items: [] })
        await runWorkflowWorker({
          ...runtime,
          workflows: [implementation],
          workerId: 'empty-map-worker',
          container: createTestContainer(),
        })
        await expect(client.get(run.id)).resolves.toMatchObject({
          run: { status: 'completed', output: 0 },
          children: [],
        })
      })

      it('distinguishes own __proto__ properties in idempotency and uniqueness keys', async () => {
        const { runtime } = createHarness()
        const keyA: unknown = JSON.parse('{"__proto__":{"tenant":"a"}}')
        const keyB: unknown = JSON.parse('{"__proto__":{"tenant":"b"}}')
        const a = await runtime.store.createRun({
          workflowName: 'identity',
          input: null,
          idempotencyKey: [keyA],
        })
        const b = await runtime.store.createRun({
          workflowName: 'identity',
          input: null,
          idempotencyKey: [keyB],
        })
        expect(a.id).not.toBe(b.id)
        const uniqueA = await runtime.store.createRun({
          workflowName: 'unique',
          input: null,
          unique: { key: [keyA], scope: 'active', behavior: 'reject' },
        })
        const uniqueB = await runtime.store.createRun({
          workflowName: 'unique',
          input: null,
          unique: { key: [keyB], scope: 'active', behavior: 'reject' },
        })
        expect(uniqueA.id).not.toBe(uniqueB.id)
      })

      it('does not delete a newer run uniqueness guard with an older family', async () => {
        const { runtime } = createHarness()
        const input = {
          workflowName: 'unique-owner',
          input: null,
          unique: { key: ['owner'], scope: 'active', behavior: 'reject' },
        } as const
        const a = await runtime.store.createRun(input)
        await runtime.store.completeRun({ runId: a.id, output: null })
        const b = await runtime.store.createRun(input)
        await expect(runtime.store.createRun(input)).rejects.toThrow()
        await runtime.store.deleteRun(a.id)
        await expect(runtime.store.createRun(input)).rejects.toThrow()
        expect((await runtime.store.loadRunSnapshot(b.id))?.run.status).toBe(
          'queued',
        )
      })

      it('does not expire a reused child uniqueness guard when its old family completes', async () => {
        const { runtime } = createHarness(100)
        const root = await runtime.store.createRun({
          workflowName: 'root',
          input: null,
        })
        const input = {
          workflowName: 'unique-child',
          input: null,
          unique: { key: ['child-owner'], scope: 'active', behavior: 'reject' },
        } as const
        const child = await runtime.store.createRun({
          ...input,
          parentRunId: root.id,
        })
        await runtime.store.completeRun({ runId: child.id, output: null })
        await runtime.store.createRun(input)
        await runtime.store.completeRun({ runId: root.id, output: null })
        await new Promise((resolve) => setTimeout(resolve, 160))
        await expect(runtime.store.createRun(input)).rejects.toThrow()
      })

      it('expires the terminal index without requiring a reader or pruner', async () => {
        const { client, keyPrefix, runtime } = createHarness(100)
        const run = await runtime.store.createRun({
          workflowName: 'retention',
          input: null,
        })
        await runtime.store.completeRun({ runId: run.id, output: null })
        expect(await client.pttl(`${keyPrefix}runs:terminal`)).toBeGreaterThan(
          0,
        )
        await new Promise((resolve) => setTimeout(resolve, 160))
        expect(await client.exists(`${keyPrefix}runs:terminal`)).toBe(0)
      })

      it('removes family retention on retry and rearms it after completion', async () => {
        const { client, keyPrefix, runtime } = createHarness(250)
        const workflows = createWorkflowRuntimeClient(runtime)
        const run = await runtime.store.createRun({
          workflowName: 'retry-retention',
          input: payload,
          idempotencyKey: ['retry-retention'],
          unique: {
            scope: 'active',
            key: ['retry-retention'],
            behavior: 'reject',
          },
        })
        const failed = await runtime.store.failRun({
          runId: run.id,
          error: new Error('failed'),
        })
        expect(
          await client.pttl(`${keyPrefix}family:${run.id}`),
        ).toBeGreaterThan(0)
        const retried = await workflows.retry(run.id, {
          expectedVersion: failed!.version,
        })
        expect(retried.status).toBe('queued')
        expect(await client.pttl(`${keyPrefix}family:${run.id}`)).toBe(-1)
        expect(await client.pttl(`${keyPrefix}run-root:${run.id}`)).toBe(-1)
        expect(
          await client.zscore(`${keyPrefix}runs:terminal`, run.id),
        ).toBeNull()
        expect(
          await client.zscore(`${keyPrefix}runs:active`, run.id),
        ).not.toBeNull()
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(
          (await runtime.store.loadRunSnapshot(run.id))?.run.input,
        ).toStrictEqual(payload)
        await runtime.store.completeRun({ runId: run.id, output: payload })
        expect(
          await client.pttl(`${keyPrefix}family:${run.id}`),
        ).toBeGreaterThan(0)
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(await runtime.store.loadRunSnapshot(run.id)).toBeUndefined()
      })

      it('repairs a joined task with the original task, payload, identity and schedule', async () => {
        const { client, keyPrefix, runtime } = createHarness()
        const firstTask = defineTask({
          name: 'first',
          input: t.object({ recipient: t.string() }),
          output: t.string(),
        })
        const secondTask = defineTask({
          name: 'second',
          input: firstTask.input,
          output: t.string(),
        })
        const workflows = createWorkflowRuntimeClient(runtime)
        const unique = {
          key: ['join'],
          scope: 'active',
          behavior: 'join',
        } as const
        const startAt = new Date(Date.now() + 60_000)
        vi.spyOn(runtime.store, 'createNode').mockRejectedValueOnce(
          new Error('interrupted task setup'),
        )
        await expect(
          workflows.start(
            firstTask,
            { recipient: 'Alice' },
            { unique, startAt, idempotencyKey: ['original'] },
          ),
        ).rejects.toThrow('interrupted')
        const joined = await workflows.start(
          secondTask,
          { recipient: 'Bob' },
          { unique, idempotencyKey: ['joining'] },
        )
        const snapshot = await runtime.store.loadRunSnapshot(joined.id)
        expect(joined.input).toStrictEqual({ recipient: 'Alice' })
        expect(snapshot?.attempts[0]?.input).toStrictEqual({
          recipient: 'Alice',
        })
        expect(snapshot?.attempts[0]?.idempotencyKey).toStrictEqual([
          'original',
        ])
        const ready = await client.zrange(
          `${keyPrefix}queue:attempt:ready`,
          '0',
          '-1',
          'WITHSCORES',
        )
        expect(Number(ready[1])).toBe(startAt.getTime())
        await expect(
          runtime.attemptExecutor.claim({
            workerId: 'early',
            workflowNames: [],
            taskNames: ['first', 'second'],
            leaseMs: 1_000,
          }),
        ).resolves.toBeNull()
      })

      it('does not redispatch a terminal run whose start marker is absent', async () => {
        const { runtime } = createHarness()
        const input = {
          workflowName: 'terminal-replay',
          input: null,
          idempotencyKey: ['done'],
        }
        const run = await runtime.store.createRun(input)
        await runtime.store.completeRun({ runId: run.id, output: 'done' })
        await expect(
          runtime.atomicStart!.startWorkflowRun({ run: input }),
        ).resolves.toMatchObject({ id: run.id, status: 'completed' })
        await expect(
          runtime.runCoordinationExecutor.claim({
            workerId: 'replay',
            workflowNames: ['terminal-replay'],
            leaseMs: 1_000,
          }),
        ).resolves.toBeNull()
      })

      it('keeps late terminal leases inside the family retention window', async () => {
        const { client, keyPrefix, runtime } = createHarness(100)
        const run = await runtime.store.createRun({
          workflowName: 'terminal-lease',
          input: null,
        })
        await runtime.store.completeRun({ runId: run.id, output: null })
        const lease = await runtime.store.acquireRunLease({
          runId: run.id,
          leaseMs: 30_000,
        })
        expect(lease).toBeDefined()
        expect(
          await client.pttl(`${keyPrefix}family:${run.id}:leases`),
        ).toBeGreaterThan(0)
        await new Promise((resolve) => setTimeout(resolve, 160))
        expect(await client.exists(`${keyPrefix}family:${run.id}:leases`)).toBe(
          0,
        )
      })

      it('does not prune live terminal indexes using a skewed client clock', async () => {
        const { runtime } = createHarness()
        const run = await runtime.store.createRun({
          workflowName: 'index-clock',
          input: null,
        })
        await runtime.store.completeRun({ runId: run.id, output: null })
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
        expect(
          (await runtime.store.listRuns()).runs.map((entry) => entry.id),
        ).toContain(run.id)
      })

      it('uses Redis time for run lease acquisition and renewal', async () => {
        const { runtime } = createHarness()
        const run = await runtime.store.createRun({
          workflowName: 'clock',
          input: null,
        })
        const now = Date.now()
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(now - 60_000)
        const lease = await runtime.store.acquireRunLease({
          runId: run.id,
          leaseMs: 1_000,
        })
        expect(lease).toBeDefined()
        vi.setSystemTime(now + 60_000)
        await expect(
          runtime.store.acquireRunLease({ runId: run.id, leaseMs: 1_000 }),
        ).resolves.toBeUndefined()
        expect(await runtime.store.renewRunLease(lease!, 1_000)).toBeDefined()
        vi.useRealTimers()
        await expect(
          runtime.store.acquireRunLease({ runId: run.id, leaseMs: 1_000 }),
        ).resolves.toBeUndefined()
      })
    },
  )
}
