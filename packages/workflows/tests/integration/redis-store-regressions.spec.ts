import { randomUUID } from 'node:crypto'

import { createFuture } from '@nmtjs/common'
import { t } from '@nmtjs/type'
import { Redis } from 'ioredis'
import { Redis as Valkey } from 'iovalkey'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { StoredRun } from '../../src/runtime/state.ts'
import { createRedisWorkflowRuntime } from '../../src/adapters/redis.ts'
import { RedisWorkflowScripts } from '../../src/adapters/redis/scripts.ts'
import { RedisWorkflowStoreScripts } from '../../src/adapters/redis/store-scripts.ts'
import {
  defineTask,
  defineWorkflow,
  implementWorkflow,
} from '../../src/index.ts'
import {
  createWorkflowRuntimeClient,
  runWorkflowWorker,
} from '../../src/runtime/index.ts'
import { reapDeadWorkflowCommands } from '../../src/runtime/worker.ts'
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

      const createHarness = (
        terminalRetentionMs = 5_000,
        maxDeliveries = 20,
      ) => {
        const client = new target.Client(target.url!, {
          maxRetriesPerRequest: 1,
          commandTimeout: 2_000,
        })
        const keyPrefix = `nmtjs:test:store-regression:${randomUUID()}:`
        const runtime = createRedisWorkflowRuntime({
          client,
          keyPrefix,
          terminalRetentionMs,
          maxDeliveries,
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

      it('keeps Date identities distinct and replays Date inputs using their stored JSON form', async () => {
        const { runtime } = createHarness()
        const firstDate = new Date('2025-01-01T00:00:00.000Z')
        const secondDate = new Date('2026-01-01T00:00:00.000Z')
        const first = await runtime.store.createRun({
          workflowName: 'date-identity',
          input: { date: firstDate },
          idempotencyKey: [firstDate],
        })
        const replay = await runtime.store.createRun({
          workflowName: 'date-identity',
          input: { date: firstDate },
          idempotencyKey: [firstDate],
        })
        expect(replay.id).toBe(first.id)
        const second = await runtime.store.createRun({
          workflowName: 'date-identity',
          input: { date: secondDate },
          idempotencyKey: [secondDate],
        })
        expect(second.id).not.toBe(first.id)
        for (const scope of ['active', 'all'] as const) {
          const original = await runtime.store.createRun({
            workflowName: 'date-unique',
            input: null,
            unique: { scope, key: [firstDate], behavior: 'reject' },
          })
          const distinct = await runtime.store.createRun({
            workflowName: 'date-unique',
            input: null,
            unique: { scope, key: [secondDate], behavior: 'reject' },
          })
          expect(distinct.id).not.toBe(original.id)
        }
      })

      it('expires state and lookups created after the family became terminal', async () => {
        const { client, keyPrefix, runtime } = createHarness(500)
        const run = await runtime.store.createRun({
          workflowName: 'late-state',
          input: null,
        })
        await runtime.store.completeRun({ runId: run.id, output: null })
        await runtime.store.createNode({
          runId: run.id,
          name: 'late',
          kind: 'activity',
        })
        await runtime.store.ensureNodeChildren({
          runId: run.id,
          nodeName: 'late',
          children: [{ childKey: 'one', kind: 'activity' }],
        })
        const { attempt } = await runtime.store.ensureChildAttempt({
          runId: run.id,
          nodeName: 'late',
          childKey: 'one',
          input: null,
        })
        const keys = ['nodes', 'children', 'attempts', 'indexes'].map(
          (part) => `${keyPrefix}family:${run.id}:${part}`,
        )
        keys.push(`${keyPrefix}attempt-root:${attempt.id}`)
        for (const key of keys)
          expect(await client.pttl(key)).toBeGreaterThan(0)
        await expect
          .poll(() => client.exists(...keys), { timeout: 2000 })
          .toBe(0)
      })

      it('does not erase a successful retry while deleting its terminal family', async () => {
        const { runtime } = createHarness()
        const run = await runtime.store.createRun({
          workflowName: 'retry-delete',
          input: null,
        })
        const failed = await runtime.store.failRun({
          runId: run.id,
          error: new Error('failed'),
        })
        const entered = createFuture<void>()
        const release = createFuture<void>()
        // oxlint-disable-next-line typescript/unbound-method -- Rebound to the intercepted queue script instance below.
        const runRaw = RedisWorkflowScripts.prototype.runRaw
        let queues = 0
        vi.spyOn(RedisWorkflowScripts.prototype, 'runRaw').mockImplementation(
          async function (this: RedisWorkflowScripts, name, keys, args) {
            if (name === 'deleteForRuns') {
              queues += 1
              if (queues === 2) entered.resolve()
              await release.promise
            }
            return runRaw.call(this, name, keys, args)
          },
        )
        const deleting = runtime.store.deleteRun(run.id).then(
          () => true,
          () => false,
        )
        await entered.promise
        let retried = false
        try {
          await runtime.store.reopenFailedRun({
            runId: run.id,
            expectedVersion: failed!.version,
          })
          retried = true
        } catch {
          // Either operation may win, but a successful retry must retain its work.
        } finally {
          release.resolve()
        }
        const deleted = await deleting
        if (retried) {
          expect(deleted).toBe(false)
          expect(
            await runtime.runCoordinationExecutor.claim({
              workerId: 'retry-delete',
              workflowNames: ['retry-delete'],
              leaseMs: 1000,
            }),
          ).not.toBeNull()
        } else {
          expect(deleted).toBe(true)
          expect(await runtime.store.loadRunSnapshot(run.id)).toBeUndefined()
        }
      })

      it('retries only its indexed commands with unrelated work in both queues', async () => {
        const { client, keyPrefix, runtime } = createHarness()
        const run = await runtime.store.createRun({
          workflowName: 'indexed-retry',
          input: null,
        })
        await runtime.runCoordinationExecutor.enqueue({
          kind: 'continueRun',
          runId: run.id,
          workflowName: run.workflowName,
        })
        await runtime.store.failRun({
          runId: run.id,
          error: new Error('retry'),
        })
        await Promise.all(
          Array.from({ length: 1000 }, async () => {
            const unrelated = randomUUID()
            await runtime.runCoordinationExecutor.enqueue({
              kind: 'continueRun',
              runId: unrelated,
              workflowName: 'offline',
            })
            await runtime.attemptExecutor.dispatchActivity({
              kind: 'activityAttempt',
              runId: unrelated,
              workflowName: 'offline',
              activityName: 'offline',
              nodeName: 'offline',
              childKey: 'one',
              attemptId: randomUUID(),
              leaseToken: randomUUID(),
              input: null,
            })
          }),
        )
        const monitor = await client.monitor()
        const commands: string[][] = []
        monitor.on('monitor', (_time: unknown, args: string[]) =>
          commands.push(args),
        )
        try {
          await createWorkflowRuntimeClient(runtime).retry(run.id)
          await client.echo('retried')
          await expect
            .poll(() =>
              commands.some(
                ([name, value]) =>
                  name?.toLowerCase() === 'echo' && value === 'retried',
              ),
            )
            .toBe(true)
          const queueKeys = new Set(
            ['continue', 'attempt'].map(
              (kind) => `${keyPrefix}queue:${kind}:items`,
            ),
          )
          expect(
            commands.filter(
              ([name, key]) =>
                name?.toLowerCase() === 'hgetall' && queueKeys.has(key!),
            ),
          ).toEqual([])
          const reads = commands.filter(
            ([name, key]) =>
              name?.toLowerCase() === 'hget' && queueKeys.has(key!),
          )
          expect(reads.length).toBeLessThan(10)
          const claim = await runtime.runCoordinationExecutor.claim({
            workerId: 'retry',
            workflowNames: [run.workflowName],
            leaseMs: 1000,
          })
          expect(claim?.command.runId).toBe(run.id)
          await runtime.runCoordinationExecutor.ack(claim!)
          expect(
            await client.smembers(`${keyPrefix}queue:continue:run:${run.id}`),
          ).toEqual([])
          expect(await client.hlen(`${keyPrefix}queue:continue:items`)).toBe(
            1000,
          )
          expect(await client.hlen(`${keyPrefix}queue:attempt:items`)).toBe(
            1000,
          )
        } finally {
          monitor.disconnect()
        }
      })

      it('does not reap a retired command when an unrelated dead command remains', async () => {
        const { runtime } = createHarness(5000, 1)
        const runs: StoredRun[] = []
        for (const name of ['retired', 'unrelated']) {
          const run = await runtime.store.createRun({
            workflowName: name,
            input: null,
          })
          runs.push(run)
          await runtime.runCoordinationExecutor.enqueue({
            kind: 'continueRun',
            runId: run.id,
            workflowName: name,
          })
          const claim = await runtime.runCoordinationExecutor.claim({
            workerId: name,
            workflowNames: [name],
            leaseMs: 1000,
          })
          await runtime.runCoordinationExecutor.release(claim!, {
            error: new Error('dead'),
          })
        }
        const run = runs[0]!
        await runtime.store.failRun({
          runId: run.id,
          error: new Error('failed'),
        })
        const dead = await runtime.store.listUnreapedDeadCommands()
        const stale = dead.find((command) => command.runId === run.id)!
        expect(
          await runtime.store.listUnreapedDeadCommands({
            commandId: 'missing',
          }),
        ).toEqual([])
        expect(
          await runtime.store.listUnreapedDeadCommands({ commandId: stale.id }),
        ).toEqual([stale])
        await createWorkflowRuntimeClient(runtime).retry(run.id)
        const before = await runtime.store.loadRunSnapshot(run.id)
        const store = runtime.store
        await reapDeadWorkflowCommands({
          ...runtime,
          store: {
            ...store,
            listUnreapedDeadCommands: (params) => {
              if (params?.commandId !== undefined)
                return store.listUnreapedDeadCommands(params)
              return Promise.resolve([stale])
            },
          },
        })
        expect(await store.loadRunSnapshot(run.id)).toEqual(before)
        expect(
          await store.listUnreapedDeadCommands({ commandId: stale.id }),
        ).toEqual([])
        const remaining = await store.listUnreapedDeadCommands()
        expect(remaining).toHaveLength(1)
        expect(remaining[0]?.runId).toBe(runs[1]!.id)
      })

      it('skips families with live children without consuming the pruning batch', async () => {
        const { runtime } = createHarness()
        const root = await runtime.store.createRun({
          workflowName: 'live-family',
          input: null,
        })
        await runtime.store.createNode({
          runId: root.id,
          name: 'child',
          kind: 'workflow',
        })
        await runtime.store.ensureNodeChildren({
          runId: root.id,
          nodeName: 'child',
          children: [{ childKey: 'only', kind: 'workflow' }],
        })
        const { childRun } = await runtime.store.ensureChildRun({
          runId: root.id,
          nodeName: 'child',
          childKey: 'only',
          childKind: 'workflow',
          childName: 'child',
          input: null,
          rootRunId: root.id,
        })
        await runtime.store.completeRun({ runId: root.id, output: null })
        const eligible = await runtime.store.createRun({
          workflowName: 'eligible',
          input: null,
        })
        await runtime.store.completeRun({ runId: eligible.id, output: null })
        expect(
          await runtime.store.pruneTerminalRuns({
            olderThan: new Date(Date.now() + 1000),
            batchSize: 1,
          }),
        ).toEqual({ deleted: 1 })
        expect(await runtime.store.loadRunSnapshot(root.id)).toBeDefined()
        expect(await runtime.store.loadRunSnapshot(childRun.id)).toBeDefined()
        expect(await runtime.store.loadRunSnapshot(eligible.id)).toBeUndefined()
      })

      it('rechecks the pruning cutoff after a concurrent retry completes', async () => {
        const { runtime } = createHarness()
        const run = await runtime.store.createRun({
          workflowName: 'prune-retry',
          input: null,
        })
        const failed = await runtime.store.failRun({
          runId: run.id,
          error: new Error('retry'),
        })
        const olderThan = new Date(failed!.updatedAt.getTime() + 1)
        await expect
          .poll(() => Date.now())
          .toBeGreaterThanOrEqual(olderThan.getTime())
        // oxlint-disable-next-line typescript/unbound-method -- Rebound to the intercepted instance with call below.
        const original = RedisWorkflowStoreScripts.prototype.run
        let retried = false
        vi.spyOn(RedisWorkflowStoreScripts.prototype, 'run').mockImplementation(
          async function (this: RedisWorkflowStoreScripts, name, keys, args) {
            if (name === 'deleteFamily' && !retried) {
              retried = true
              await runtime.store.reopenFailedRun({
                runId: run.id,
                expectedVersion: failed!.version,
              })
              await runtime.store.completeRun({
                runId: run.id,
                output: 'new result',
              })
            }
            return original.call(this, name, keys, args)
          },
        )
        expect(await runtime.store.pruneTerminalRuns({ olderThan })).toEqual({
          deleted: 0,
        })
        expect(retried).toBe(true)
        expect((await runtime.store.loadRunSnapshot(run.id))?.run.output).toBe(
          'new result',
        )
      })

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
