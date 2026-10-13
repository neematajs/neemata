import { randomUUID } from 'node:crypto'

import type { Redis } from 'ioredis'
import type { Redis as Valkey } from 'iovalkey'
import { afterEach, describe, expect, it } from 'vitest'
import * as z from 'zod'

import type {
  DefinitionStructure,
  RevisionManifest,
} from '../../src/inspector/graph.ts'
import type { RouteRef } from '../../src/runtime/commands.ts'
import type { RunnableDefinition } from '../../src/types/index.ts'
import { createRedisWorkflowRuntime } from '../../src/adapters/redis.ts'
import { Keys } from '../../src/adapters/redis/keys.ts'
import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../../src/index.ts'
import {
  canonicalJson,
  captureGraphPresentation,
  projectStructure,
} from '../../src/inspector/graph.ts'
import {
  childRunDefinitionInput,
  describeDefinition,
  hashStructure,
  runDefinitionInput,
} from '../../src/runtime/definition.ts'
import {
  StaleWriteFenceError,
  WorkflowDefinitionConflictError,
  WorkflowIdempotencyConflictError,
  WorkflowRunConflictError,
} from '../../src/runtime/errors.ts'
import {
  createWorkflowRuntimeClient,
  runExecutionWorker,
  runWorkflowWorker,
} from '../../src/runtime/index.ts'
import {
  activityCommand,
  disposeRedisRuntimes,
  matchingKeys,
  redisTargets,
  wait,
} from './helpers.ts'

const text = z.string()

/** One activity, `step`. Equal names give equal graphs whatever the revision. */
function flow(name: string, revision?: string) {
  return defineWorkflow({ name, revision, input: text, output: text })
    .activity('step', { input: text, output: text })
    .build()
}

/** The same name with another graph: a second activity. */
function widerFlow(name: string, revision?: string) {
  return defineWorkflow({ name, revision, input: text, output: text })
    .activity('step', { input: text, output: text })
    .activity('extra', { input: text, output: text })
    .build()
}

function implement(definition: ReturnType<typeof flow>, tag: string) {
  return implementWorkflow(definition, { pool: 'test' })
    .step(async (input) => `${input}-${tag}`)
    .finish(({ step }) => step)
}

/** The run input a caller of this binary sends for `definition`. */
function runOf(definition: RunnableDefinition, input: unknown = 'in') {
  return {
    kind: definition.kind,
    workflowName: definition.name,
    ...(definition.kind === 'task' ? { taskName: definition.name } : {}),
    input,
    ...runDefinitionInput(definition),
  }
}

function manifestOf(definition: RunnableDefinition): RevisionManifest {
  const { manifest } = describeDefinition(definition)
  if (!manifest) throw new Error(`[${definition.name}] is unversioned`)
  return manifest
}

function taskCommand(runId: string, taskName: string, revision?: string) {
  return {
    kind: 'taskAttempt' as const,
    workflowName: taskName,
    taskName,
    ...(revision === undefined ? {} : { revision }),
    runId,
    nodeName: '$task',
    childKey: '$self',
    attemptId: randomUUID(),
    leaseToken: randomUUID(),
    input: null,
  }
}

function continueCommand(
  runId: string,
  workflowName: string,
  revision?: string,
) {
  return {
    kind: 'continueRun' as const,
    runId,
    workflowName,
    ...(revision === undefined ? {} : { revision }),
  }
}

/** A length-prefixed route part, as the queue scripts encode one. */
function part(value: string) {
  return `${Buffer.byteLength(value)}:${value}`
}

type StoredItem = {
  readonly id: string
  readonly payload: { readonly runId: string; readonly revision?: string }
  readonly deliveryCount: number
  readonly deadAt?: number
  readonly leaseToken?: string
  readonly lastError?: string
}

for (const target of redisTargets) {
  describe.skipIf(!target.url)(
    `Redis execution revisions against ${target.name}`,
    () => {
      const clients: (Redis | Valkey)[] = []
      const runtimes: ReturnType<typeof createRedisWorkflowRuntime>[] = []

      afterEach(async () => {
        await disposeRedisRuntimes(runtimes, clients)
      })

      function createHarness(options?: {
        readonly maxDeliveries?: number
        readonly terminalRetentionMs?: number
      }) {
        const client = target.createClient()
        const keyPrefix = `nmtjs:test:revisions:${randomUUID()}:`
        const runtime = createRedisWorkflowRuntime({
          client,
          keyPrefix,
          maxDeliveries: options?.maxDeliveries ?? 3,
          terminalRetentionMs: options?.terminalRetentionMs ?? 60_000,
        })
        clients.push(client)
        runtimes.push(runtime)
        const keys = new Keys(keyPrefix)

        /** Every key of this runtime with its whole content. */
        async function dump() {
          const names = await matchingKeys(client, `${keyPrefix}*`)
          const content: Record<string, unknown> = {}
          for (const key of names.sort()) {
            const type = await client.type(key)
            if (type === 'hash') {
              content[key] = await client.hgetall(key)
            } else if (type === 'zset') {
              content[key] = await client.zrange(key, '0', '-1', 'WITHSCORES')
            } else if (type === 'set') {
              content[key] = (await client.smembers(key)).sort()
            } else {
              content[key] = await client.get(key)
            }
          }
          return content
        }

        async function items(kind: 'continue' | 'attempt') {
          const raw = await client.hgetall(keys.queue(kind).items)
          return Object.values(raw).map((item): StoredItem => JSON.parse(item))
        }

        async function itemOf(kind: 'continue' | 'attempt', runId: string) {
          const found = (await items(kind)).filter(
            (item) => item.payload.runId === runId,
          )
          expect(found).toHaveLength(1)
          return found[0]!
        }

        function route(kind: 'continue' | 'attempt', ...segments: string[]) {
          return `${keyPrefix}queue:${kind}:route:${segments.join(':')}`
        }

        function claimContinue(...workflows: RouteRef[]) {
          return runtime.runCoordinationExecutor.claim({
            workerId: 'revisions',
            workflows,
            leaseMs: 30_000,
          })
        }

        function claimAttempt(routes: {
          readonly workflows?: readonly RouteRef[]
          readonly tasks?: readonly RouteRef[]
          readonly activityNames?: readonly string[]
        }) {
          const { workflows = [], tasks = [], activityNames } = routes
          return runtime.attemptExecutor.claim({
            workerId: 'revisions',
            workflows,
            tasks,
            ...(activityNames === undefined ? {} : { activityNames }),
            leaseMs: 30_000,
          })
        }

        return {
          client,
          keyPrefix,
          keys,
          runtime,
          store: runtime.store,
          dump,
          items,
          itemOf,
          route,
          claimContinue,
          claimAttempt,
        }
      }

      type Harness = ReturnType<typeof createHarness>

      /** A parent run with one pending child slot per key on node `sub`. */
      async function parentWithSlots(
        { store }: Harness,
        parent: RunnableDefinition,
        childKeys: readonly string[],
      ) {
        const run = await store.createRun(runOf(parent))
        await store.createNode({ runId: run.id, name: 'sub', kind: 'workflow' })
        await store.ensureNodeChildren({
          runId: run.id,
          nodeName: 'sub',
          children: childKeys.map((childKey, ordinal) => ({
            childKey,
            kind: 'workflow' as const,
            ordinal,
          })),
        })
        return run
      }

      describe('atomic create', () => {
        it('saves the whole closure, the run, its labels and its command in one start', async () => {
          const harness = createHarness()
          const { client, keys, runtime, store, route } = harness
          const task = defineTask({
            name: 'create.embed',
            revision: 'v1',
            input: text,
            output: text,
            title: 'Embed',
          })
          const child = flow('create.child', 'v1')
          const parent = defineWorkflow({
            name: 'create.parent',
            revision: 'v1',
            input: text,
            output: text,
            title: 'Parent',
          })
            .activity('load', { input: text, output: text, title: 'Load' })
            .task('embed', task)
            .branch('route', {
              output: text,
              cases: (helpers) => ({
                viaTask: helpers.task(task),
                viaChild: helpers.workflow(child, { title: 'Via child' }),
                inline: helpers.activity({ input: text, output: text }),
              }),
            })
            .build()
          const api = createWorkflowRuntimeClient(runtime)

          const run = await api.start(parent, 'in')

          const { graphHash } = describeDefinition(parent)
          const stored = (await store.loadRuns([run.id]))[0]!
          expect(stored.executionRevision).toBe('v1')
          expect(stored.graphHash).toBe(graphHash)
          for (const definition of [parent, child, task]) {
            const described = describeDefinition(definition)
            expect(await store.loadGraph(described.graphHash)).toStrictEqual({
              graphHash: described.graphHash,
              structure: projectStructure(definition),
            })
            expect(await store.loadRevision(manifestOf(definition))).toEqual(
              described.manifest,
            )
          }
          expect(await store.loadGraphPresentation(run.id)).toStrictEqual(
            captureGraphPresentation(parent),
          )

          const [item] = await harness.items('continue')
          expect(item!.payload).toStrictEqual(
            continueCommand(run.id, parent.name, 'v1'),
          )
          const versioned = route(
            'continue',
            'rev:workflow',
            part(parent.name),
            part('v1'),
          )
          expect(await client.zrange(`${versioned}:ready`, '0', '-1')).toEqual([
            item!.id,
          ])
          expect(
            await client.exists(
              `${route('continue', 'workflow', part(parent.name))}:ready`,
            ),
          ).toBe(0)
          expect(await client.exists(keys.startDispatch(run.id))).toBe(1)
        })

        it('stores structures and manifests as the canonical bytes, empty arrays and node order included', async () => {
          const { client, keys, store } = createHarness()
          const name = 'bytes.flow'
          const structure: DefinitionStructure = {
            formatVersion: 1,
            kind: 'workflow',
            name,
            nodes: [
              { name: 'route', kind: 'branch', cases: [] },
              { name: 'zeta', kind: 'activity' },
              { name: 'alpha', kind: 'activity' },
            ],
          }
          const graphHash = hashStructure(structure)
          const manifest: RevisionManifest = {
            kind: 'workflow',
            name,
            revision: 'v1',
            graphHash,
            bindings: [],
          }

          const run = await store.createRun({
            workflowName: name,
            input: null,
            executionRevision: 'v1',
            graphHash,
            definitions: {
              graphs: [{ graphHash, structure }],
              revisions: [manifest],
            },
          })

          const graphJson =
            `{"formatVersion":1,"kind":"workflow","name":"${name}","nodes":[` +
            '{"cases":[],"kind":"branch","name":"route"},' +
            '{"kind":"activity","name":"zeta"},' +
            '{"kind":"activity","name":"alpha"}]}'
          const key = `["workflow","${name}","v1"]`
          expect(await client.hget(keys.graphs(), graphHash)).toBe(graphJson)
          expect(await client.hgetall(keys.revisions())).toStrictEqual({
            [`manifest:${key}`]: `{"bindings":[],"graphHash":"${graphHash}"}`,
            [`graph:${key}`]: graphHash,
          })

          const loaded = await store.loadGraph(graphHash)
          expect(loaded).toStrictEqual({ graphHash, structure })
          expect(canonicalJson(loaded!.structure)).toBe(graphJson)
          expect(await store.loadRevision(manifest)).toStrictEqual(manifest)

          // Scripts re-encode the run record itself; what it is pinned to and
          // the shared definitions must come through every such transition.
          await store.markRunRunning({ runId: run.id })
          await store.markRunWaiting({ runId: run.id })
          const failed = await store.failRun({
            runId: run.id,
            error: new Error('failed'),
          })
          expect(failed).toMatchObject({
            status: 'failed',
            executionRevision: 'v1',
            graphHash,
          })
          expect(await client.hget(keys.graphs(), graphHash)).toBe(graphJson)
        })

        it('refuses a graph saved with other content and writes nothing', async () => {
          const { client, keys, store, dump } = createHarness()
          const definition = flow('collision.flow', 'v1')
          const { graphHash } = describeDefinition(definition)
          // A hash collision cannot be produced, so another structure is
          // planted under the hash this definition is about to use.
          await client.hset(
            keys.graphs(),
            graphHash,
            '{"formatVersion":1,"kind":"task","name":"collision.other"}',
          )
          const before = await dump()

          const refused = await store
            .createRun(runOf(definition))
            .catch((error: unknown) => error)

          expect(refused).toBeInstanceOf(WorkflowDefinitionConflictError)
          expect(refused).toHaveProperty(
            'message',
            `Graph [${graphHash}] is already saved with different content`,
          )
          expect(Object.keys(before)).toEqual([keys.graphs()])
          expect(await dump()).toStrictEqual(before)
          expect((await store.listRuns()).runs).toEqual([])
        })

        it('refuses another manifest for a saved revision and writes nothing', async () => {
          const { runtime, store, dump } = createHarness()
          const api = createWorkflowRuntimeClient(runtime)
          const first = await api.start(flow('manifest.flow', 'v1'), 'in')
          const before = await dump()

          // Another graph under the same revision.
          await expect(
            api.start(widerFlow('manifest.flow', 'v1'), 'in'),
          ).rejects.toThrow(
            'workflow [manifest.flow@v1] is already saved with a different graph or different child revisions',
          )
          expect(await dump()).toStrictEqual(before)

          // The same graph, bound to another child revision.
          const child = flow('manifest.child', 'v1')
          const parent = (revision: string) =>
            defineWorkflow({
              name: 'manifest.parent',
              revision: 'v1',
              input: text,
              output: text,
            })
              .workflow('sub', flow('manifest.child', revision))
              .build()
          expect(describeDefinition(parent('v2')).graphHash).toBe(
            describeDefinition(parent('v1')).graphHash,
          )
          await api.start(parent('v1'), 'in')
          const bound = await dump()

          const refused = await api
            .start(parent('v2'), 'in')
            .catch((error: unknown) => error)

          expect(refused).toBeInstanceOf(WorkflowDefinitionConflictError)
          expect(await dump()).toStrictEqual(bound)
          expect(await store.loadRevision(manifestOf(parent('v1')))).toEqual(
            manifestOf(parent('v1')),
          )
          expect(
            await store.loadRevision({ ...manifestOf(child), revision: 'v2' }),
          ).toBeUndefined()
          expect((await store.listRuns()).runs.map((run) => run.id)).toContain(
            first.id,
          )
        })

        it('refuses a run whose graph or manifest is neither saved nor provided', async () => {
          const { store, dump } = createHarness()
          const saved = flow('missing.flow', 'v1')
          const other = widerFlow('missing.flow')
          await store.createRun(runOf(saved))
          await store.createRun(runOf(other))
          const before = await dump()
          const identity = {
            workflowName: 'missing.flow',
            input: 'in',
          }
          const unsaved = describeDefinition(flow('missing.unsaved')).graphHash
          const savedHash = describeDefinition(saved).graphHash
          const otherHash = describeDefinition(other).graphHash

          await expect(
            store.createRun({ ...identity, graphHash: unsaved }),
          ).rejects.toThrow(
            `Graph [${unsaved}] is not saved and was not provided`,
          )
          await expect(
            store.createRun({
              ...identity,
              executionRevision: 'v2',
              graphHash: savedHash,
            }),
          ).rejects.toThrow(
            'workflow [missing.flow@v2] is not saved and was not provided',
          )
          // Saved, but with another graph than the run names.
          await expect(
            store.createRun({
              ...identity,
              executionRevision: 'v1',
              graphHash: otherHash,
            }),
          ).rejects.toThrow(
            `workflow [missing.flow@v1] is saved with graph [${savedHash}], not [${otherHash}]`,
          )
          // The kind is part of a revision's identity.
          await expect(
            store.createRun({
              ...identity,
              kind: 'task',
              taskName: 'missing.flow',
              executionRevision: 'v1',
              graphHash: savedHash,
            }),
          ).rejects.toThrow(
            'task [missing.flow@v1] is not saved and was not provided',
          )
          expect(await dump()).toStrictEqual(before)

          // Saved definitions need not be sent again.
          const run = await store.createRun({
            ...identity,
            executionRevision: 'v1',
            graphHash: savedHash,
          })
          expect(run).toMatchObject({
            executionRevision: 'v1',
            graphHash: savedHash,
          })
        })

        it('lets concurrent starts of one revision share its definitions', async () => {
          const { client, keys, runtime, store } = createHarness()
          const api = createWorkflowRuntimeClient(runtime)
          const definition = flow('concurrent.same', 'v1')

          const runs = await Promise.all(
            Array.from({ length: 12 }, (_, index) =>
              api.start(definition, `in-${index}`),
            ),
          )

          expect(new Set(runs.map((run) => run.id)).size).toBe(12)
          expect(await client.hlen(keys.graphs())).toBe(1)
          expect(await client.hlen(keys.revisions())).toBe(2)
          expect(
            (await store.listRuns({ executionRevision: 'v1' })).runs,
          ).toHaveLength(12)
          expect(await client.hlen(keys.queue('continue').items)).toBe(12)
        })

        it('lets exactly one manifest win concurrent starts of one revision', async () => {
          const { client, keys, runtime, store } = createHarness()
          const api = createWorkflowRuntimeClient(runtime)
          const narrow = flow('concurrent.split', 'v1')
          const wide = widerFlow('concurrent.split', 'v1')

          const settled = await Promise.allSettled(
            Array.from({ length: 12 }, (_, index) =>
              api.start(index % 2 === 0 ? narrow : wide, `in-${index}`),
            ),
          )

          const winners = new Set<string>()
          for (const [index, result] of settled.entries()) {
            if (result.status === 'fulfilled') {
              winners.add(index % 2 === 0 ? 'narrow' : 'wide')
            } else {
              expect(result.reason).toBeInstanceOf(
                WorkflowDefinitionConflictError,
              )
            }
          }
          expect(winners.size).toBe(1)
          const winner = winners.has('narrow') ? narrow : wide
          const { graphHash } = describeDefinition(winner)
          expect(await store.loadRevision(manifestOf(winner))).toEqual(
            manifestOf(winner),
          )
          // The losers were refused before their first write: no run, no
          // command, and not even their graph.
          const { runs } = await store.listRuns()
          expect(runs).toHaveLength(6)
          expect(runs.every((run) => run.graphHash === graphHash)).toBe(true)
          expect(await client.hkeys(keys.graphs())).toEqual([graphHash])
          expect(await client.hlen(keys.queue('continue').items)).toBe(6)
        })
      })

      describe('child runs', () => {
        function parentOf(child: ReturnType<typeof flow>, revision?: string) {
          return defineWorkflow({
            name: 'children.parent',
            revision,
            input: text,
            output: text,
          })
            .workflow('sub', child)
            .build()
        }

        it('creates and replays a child of a versioned parent from the saved closure, under its lease', async () => {
          const harness = createHarness()
          const { store, dump } = harness
          const child = defineWorkflow({
            name: 'children.child',
            revision: 'v1',
            input: text,
            output: text,
            title: 'Child',
          })
            .activity('step', { input: text, output: text })
            .build()
          const parent = await parentWithSlots(harness, parentOf(child, 'v1'), [
            '$self',
          ])
          const lease = (await store.acquireRunLease({
            runId: parent.id,
            leaseMs: 30_000,
          }))!
          const identity = childRunDefinitionInput(parent, child)
          // A versioned parent saved its closure at its own start.
          expect(identity.definitions).toBeUndefined()
          const params = {
            runId: parent.id,
            nodeName: 'sub',
            childKey: '$self',
            childKind: 'workflow' as const,
            childName: child.name,
            input: 'in',
            rootRunId: parent.rootRunId,
            ...identity,
            fence: { runLease: lease },
          }

          const created = await store.ensureChildRun(params)

          expect(created.created).toBe(true)
          expect(created.childRun).toMatchObject({
            executionRevision: 'v1',
            graphHash: describeDefinition(child).graphHash,
            parentRunId: parent.id,
            rootRunId: parent.id,
          })
          expect(created.child.childRunId).toBe(created.childRun.id)
          expect(
            await store.loadGraphPresentation(created.childRun.id),
          ).toStrictEqual({ title: 'Child' })

          const linked = await dump()
          const replayed = await store.ensureChildRun(params)
          expect(replayed.created).toBe(false)
          expect(replayed.childRun.id).toBe(created.childRun.id)

          // Another revision, or none, is not the run this slot holds.
          for (const executionRevision of ['v2', undefined]) {
            await expect(
              store.ensureChildRun({ ...params, executionRevision }),
            ).rejects.toThrow(`Conflicting child run [${parent.id}.sub.$self]`)
          }
          expect(await dump()).toStrictEqual(linked)
        })

        it('refuses a child whose revision the closure does not hold and leaves the slot unlinked', async () => {
          const harness = createHarness()
          const { store, dump } = harness
          const child = flow('children.child', 'v1')
          const parent = await parentWithSlots(harness, parentOf(child, 'v1'), [
            '$self',
          ])
          const before = await dump()

          await expect(
            store.ensureChildRun({
              runId: parent.id,
              nodeName: 'sub',
              childKey: '$self',
              childKind: 'workflow',
              childName: child.name,
              input: 'in',
              rootRunId: parent.rootRunId,
              // Same graph, so only the missing manifest can refuse it.
              ...childRunDefinitionInput(parent, flow('children.child', 'v9')),
            }),
          ).rejects.toThrow(
            'workflow [children.child@v9] is not saved and was not provided',
          )

          expect(await dump()).toStrictEqual(before)
          const { children } = await store.loadNodeChildren({
            runId: parent.id,
            nodeName: 'sub',
          })
          expect(children[0]).toMatchObject({ status: 'pending' })
          expect(children[0]!.childRunId).toBeUndefined()
        })

        it('writes no definition, run or link once the fence is lost', async () => {
          const harness = createHarness()
          const { store, dump } = harness
          const child = flow('children.fenced', 'v1')
          // An unversioned parent saves nothing about its targets, so the
          // child would bring definitions nobody has saved yet.
          const parent = await parentWithSlots(harness, parentOf(child), [
            '$self',
          ])
          const lease = (await store.acquireRunLease({
            runId: parent.id,
            leaseMs: 30_000,
          }))!
          const identity = childRunDefinitionInput(parent, child)
          expect(identity.definitions).toBeDefined()
          await store.releaseRunLease(lease)
          const before = await dump()

          await expect(
            store.ensureChildRun({
              runId: parent.id,
              nodeName: 'sub',
              childKey: '$self',
              childKind: 'workflow',
              childName: child.name,
              input: 'in',
              rootRunId: parent.rootRunId,
              ...identity,
              fence: { runLease: lease },
            }),
          ).rejects.toBeInstanceOf(StaleWriteFenceError)

          expect(await dump()).toStrictEqual(before)
          expect(await store.loadRevision(manifestOf(child))).toBeUndefined()
        })

        it('links one child run when the same slot is created concurrently under one lease', async () => {
          const harness = createHarness()
          const { store } = harness
          const child = flow('children.raced', 'v1')
          const parent = await parentWithSlots(harness, parentOf(child), [
            '$self',
          ])
          const lease = (await store.acquireRunLease({
            runId: parent.id,
            leaseMs: 30_000,
          }))!
          const params = {
            runId: parent.id,
            nodeName: 'sub',
            childKey: '$self',
            childKind: 'workflow' as const,
            childName: child.name,
            input: 'in',
            rootRunId: parent.rootRunId,
            ...childRunDefinitionInput(parent, child),
            fence: { runLease: lease },
          }

          const results = await Promise.all(
            Array.from({ length: 8 }, () => store.ensureChildRun(params)),
          )

          expect(results.filter((result) => result.created)).toHaveLength(1)
          expect(
            new Set(results.map((result) => result.childRun.id)).size,
          ).toBe(1)
          expect(await store.listRunFamily(parent.id)).toHaveLength(2)
        })

        it('lets one revision win a slot raced by two and refuses the other', async () => {
          const harness = createHarness()
          const { store } = harness
          const parent = await parentWithSlots(
            harness,
            parentOf(flow('children.split')),
            ['$self'],
          )
          const params = (revision: string) => ({
            runId: parent.id,
            nodeName: 'sub',
            childKey: '$self',
            childKind: 'workflow' as const,
            childName: 'children.split',
            input: 'in',
            rootRunId: parent.rootRunId,
            ...childRunDefinitionInput(
              parent,
              flow('children.split', revision),
            ),
          })

          const settled = await Promise.allSettled(
            Array.from({ length: 8 }, (_, index) =>
              store.ensureChildRun(params(index % 2 === 0 ? 'v1' : 'v2')),
            ),
          )

          const revisions = new Set<string | undefined>()
          for (const result of settled) {
            if (result.status === 'fulfilled') {
              revisions.add(result.value.childRun.executionRevision)
            } else {
              expect(result.reason).toHaveProperty(
                'message',
                `Conflicting child run [${parent.id}.sub.$self]`,
              )
            }
          }
          expect(revisions.size).toBe(1)
          expect(
            settled.filter((result) => result.status === 'fulfilled'),
          ).toHaveLength(4)
          expect(await store.listRunFamily(parent.id)).toHaveLength(2)
        })

        it('adopts a sibling run by idempotency key only within one revision', async () => {
          const harness = createHarness()
          const { store, dump } = harness
          const parent = await parentWithSlots(
            harness,
            parentOf(flow('children.keyed')),
            ['a', 'b', 'c'],
          )
          const params = (childKey: string, revision: string) => ({
            runId: parent.id,
            nodeName: 'sub',
            childKey,
            childKind: 'workflow' as const,
            childName: 'children.keyed',
            input: 'in',
            rootRunId: parent.rootRunId,
            idempotencyKey: ['keyed'],
            ...childRunDefinitionInput(
              parent,
              flow('children.keyed', revision),
            ),
          })

          const first = await store.ensureChildRun(params('a', 'v1'))
          const adopted = await store.ensureChildRun(params('b', 'v1'))
          expect(first.created).toBe(true)
          expect(adopted.created).toBe(false)
          expect(adopted.childRun.id).toBe(first.childRun.id)
          const before = await dump()

          const refused = await store
            .ensureChildRun(params('c', 'v2'))
            .catch((error: unknown) => error)

          expect(refused).toBeInstanceOf(WorkflowIdempotencyConflictError)
          expect(refused).toMatchObject({
            workflowName: 'children.keyed',
            runId: first.childRun.id,
          })
          // Refused before its definitions were saved or its slot was linked.
          expect(await dump()).toStrictEqual(before)
        })
      })

      describe('idempotency', () => {
        it('replays within one revision and reports the owner to any other', async () => {
          const { runtime, store, dump } = createHarness()
          const api = createWorkflowRuntimeClient(runtime)
          const name = 'idempotent.flow'
          const options = { idempotencyKey: ['same'] }

          const first = await api.start(flow(name, 'v1'), 'in', options)
          const before = await dump()
          const replay = await api.start(flow(name, 'v1'), 'in', options)
          expect(replay.id).toBe(first.id)

          for (const revision of ['v2', undefined]) {
            const refused = await api
              .start(flow(name, revision), 'in', options)
              .catch((error: unknown) => error)
            expect(refused).toBeInstanceOf(WorkflowIdempotencyConflictError)
            expect(refused).toMatchObject({
              workflowName: name,
              runId: first.id,
            })
          }
          // A replay and a conflict start nothing and save nothing, v2's
          // manifest included.
          expect(await dump()).toStrictEqual(before)
          expect(
            await store.loadRevision(manifestOf(flow(name, 'v2'))),
          ).toBeUndefined()
        })

        it('replays an unversioned run and refuses a versioned request for its key', async () => {
          const { runtime } = createHarness()
          const api = createWorkflowRuntimeClient(runtime)
          const name = 'idempotent.legacy'
          const options = { idempotencyKey: ['same'] }

          const first = await api.start(flow(name), 'in', options)
          const replay = await api.start(flow(name), 'in', options)
          expect(replay.id).toBe(first.id)

          const refused = await api
            .start(flow(name, 'v1'), 'in', options)
            .catch((error: unknown) => error)
          expect(refused).toBeInstanceOf(WorkflowIdempotencyConflictError)
          expect(refused).toMatchObject({ runId: first.id })
        })

        it('ignores the graph hash when replaying an unversioned run', async () => {
          const { store } = createHarness()
          const name = 'idempotent.graphs'
          const first = await store.createRun({
            ...runOf(flow(name)),
            idempotencyKey: ['same'],
          })

          // The unversioned definition changed shape between the two calls.
          const replay = await store.createRun({
            ...runOf(widerFlow(name)),
            idempotencyKey: ['same'],
          })

          expect(replay.id).toBe(first.id)
          expect(replay.graphHash).toBe(
            describeDefinition(flow(name)).graphHash,
          )
        })
      })

      describe('unique keys', () => {
        const unique = {
          scope: 'active',
          key: ['shared'],
          behavior: 'join',
        } as const

        it('joins the same revision and refuses any other with the holder', async () => {
          const { store, dump } = createHarness()
          const name = 'unique.flow'
          const held = await store.createRun({
            ...runOf(flow(name, 'v1')),
            unique,
          })
          const before = await dump()

          const joined = await store.createRun({
            ...runOf(flow(name, 'v1'), 'other input'),
            unique,
          })
          expect(joined.id).toBe(held.id)

          const requests = [
            runOf(flow(name, 'v2')),
            runOf(flow(name)),
            runOf(flow('unique.other', 'v1')),
          ]
          for (const request of requests) {
            const refused = await store
              .createRun({ ...request, unique })
              .catch((error: unknown) => error)
            expect(refused).toBeInstanceOf(WorkflowRunConflictError)
            expect(refused).toMatchObject({
              runId: held.id,
              status: 'queued',
              key: ['shared'],
              scope: 'active',
              holder: { kind: 'workflow', name, revision: 'v1' },
            })
          }
          expect(await dump()).toStrictEqual(before)
        })

        it('reports an unversioned holder to a versioned join without a revision', async () => {
          const { store } = createHarness()
          const name = 'unique.legacy'
          const held = await store.createRun({ ...runOf(flow(name)), unique })

          const refused = await store
            .createRun({ ...runOf(flow(name, 'v1')), unique })
            .catch((error: unknown) => error)

          expect(refused).toBeInstanceOf(WorkflowRunConflictError)
          expect(refused).toMatchObject({ runId: held.id })
          expect((refused as WorkflowRunConflictError).holder).toStrictEqual({
            kind: 'workflow',
            name,
          })
        })

        it('keeps joining unversioned runs whatever they are, and rejecting without a holder', async () => {
          const { store } = createHarness()
          const held = await store.createRun({
            ...runOf(flow('unique.first')),
            unique,
          })

          const joined = await store.createRun({
            ...runOf(flow('unique.second')),
            unique,
          })
          expect(joined.id).toBe(held.id)

          for (const revision of ['v1', undefined]) {
            const refused = await store
              .createRun({
                ...runOf(flow('unique.first', revision)),
                unique: { ...unique, behavior: 'reject' },
              })
              .catch((error: unknown) => error)
            expect(refused).toBeInstanceOf(WorkflowRunConflictError)
            expect(refused).toMatchObject({ runId: held.id })
            expect((refused as WorkflowRunConflictError).holder).toBeUndefined()
          }
        })
      })

      describe('listing', () => {
        it('filters by revision and exposes it with the graph hash', async () => {
          const { store } = createHarness()
          const name = 'listed.flow'
          const legacy = await store.createRun(runOf(flow(name)))
          const v1 = await store.createRun(runOf(flow(name, 'v1')))
          const v2 = await store.createRun(runOf(widerFlow(name, 'v2')))
          const ids = async (executionRevision?: string | null) => {
            const filter =
              executionRevision === undefined ? {} : { executionRevision }
            const { runs } = await store.listRuns({ name, ...filter })
            return runs.map((run) => run.id).sort()
          }

          expect(await ids('v1')).toEqual([v1.id])
          expect(await ids('v2')).toEqual([v2.id])
          expect(await ids('v3')).toEqual([])
          expect(await ids(null)).toEqual([legacy.id])
          expect(await ids()).toEqual([legacy.id, v1.id, v2.id].sort())

          const { runs } = await store.listRunSummaries({
            executionRevision: 'v2',
          })
          expect(runs).toHaveLength(1)
          expect(runs[0]).toMatchObject({
            id: v2.id,
            executionRevision: 'v2',
            graphHash: describeDefinition(widerFlow(name, 'v2')).graphHash,
          })
          const unversioned = await store.listRunSummaries({
            executionRevision: null,
          })
          expect(unversioned.runs[0]!.executionRevision).toBeUndefined()
          expect(unversioned.runs[0]!.graphHash).toBe(
            describeDefinition(flow(name)).graphHash,
          )
        })
      })

      describe('claim isolation', () => {
        it('hands a continuation to exactly the lane it was enqueued for', async () => {
          const harness = createHarness()
          const { client, keys, runtime, claimContinue, itemOf, route } =
            harness
          const name = 'lanes.flow'
          const commands = {
            legacy: continueCommand(randomUUID(), name),
            v1: continueCommand(randomUUID(), name, 'v1'),
            v2: continueCommand(randomUUID(), name, 'v2'),
          }
          for (const command of Object.values(commands)) {
            await runtime.runCoordinationExecutor.enqueue(command)
          }
          const v2Item = await itemOf('continue', commands.v2.runId)
          expect(
            await client.zrange(
              `${route('continue', 'rev:workflow', part(name), part('v2'))}:ready`,
              '0',
              '-1',
            ),
          ).toEqual([v2Item.id])

          // Neither another name's v1 nor an unknown revision is this lane.
          expect(
            await claimContinue(
              { name: 'lanes.other', revision: 'v1' },
              { name, revision: 'v3' },
            ),
          ).toBeNull()
          expect(
            (await claimContinue({ name, revision: 'v1' }))?.command,
          ).toEqual(commands.v1)
          expect(await claimContinue({ name, revision: 'v1' })).toBeNull()
          expect((await claimContinue({ name }))?.command).toEqual(
            commands.legacy,
          )
          expect(await claimContinue({ name })).toBeNull()

          // The unserved command was never delivered, counted or dead-lettered.
          expect(await itemOf('continue', commands.v2.runId)).toStrictEqual(
            v2Item,
          )
          expect(await client.zcard(keys.queue('continue').dead)).toBe(0)
          expect(
            (await claimContinue({ name, revision: 'v2' }))?.command,
          ).toEqual(commands.v2)
        })

        it('leaves an expired lease of another lane to a worker that serves it', async () => {
          const harness = createHarness()
          const { client, keys, runtime, claimContinue, itemOf } = harness
          const name = 'lanes.expired'
          const command = continueCommand(randomUUID(), name, 'v2')
          await runtime.runCoordinationExecutor.enqueue(command)
          const claimed = await runtime.runCoordinationExecutor.claim({
            workerId: 'crashed',
            workflows: [{ name, revision: 'v2' }],
            leaseMs: 1,
          })
          await wait(25)
          const leased = await itemOf('continue', command.runId)
          expect(leased.leaseToken).toBe(claimed!.leaseToken)

          for (let pass = 0; pass < 5; pass += 1) {
            expect(
              await claimContinue({ name }, { name, revision: 'v1' }),
            ).toBeNull()
          }

          expect(await itemOf('continue', command.runId)).toStrictEqual(leased)
          expect(await client.zcard(keys.queue('continue').claimed)).toBe(1)

          const taken = await claimContinue({ name, revision: 'v2' })
          expect(taken?.command).toEqual(command)
          expect(await itemOf('continue', command.runId)).toMatchObject({
            deliveryCount: 1,
          })
        })

        it('hands a task attempt to exactly the lane it was dispatched for', async () => {
          const harness = createHarness()
          const { client, runtime, claimAttempt, itemOf, route } = harness
          const name = 'lanes.task'
          const commands = {
            legacy: taskCommand(randomUUID(), name),
            v1: taskCommand(randomUUID(), name, 'v1'),
            v2: taskCommand(randomUUID(), name, 'v2'),
          }
          for (const command of Object.values(commands)) {
            await runtime.attemptExecutor.dispatchTask(command)
          }
          expect(
            await client.zcard(`${route('attempt', 'task', part(name))}:ready`),
          ).toBe(1)
          const v2Item = await itemOf('attempt', commands.v2.runId)

          // A workflow route of the same name and revision is not a task route.
          expect(
            await claimAttempt({ workflows: [{ name, revision: 'v1' }] }),
          ).toBeNull()
          const v1 = { tasks: [{ name, revision: 'v1' }] }
          expect((await claimAttempt(v1))?.command).toEqual(commands.v1)
          expect(await claimAttempt(v1)).toBeNull()
          expect((await claimAttempt({ tasks: [{ name }] }))?.command).toEqual(
            commands.legacy,
          )
          expect(await claimAttempt({ tasks: [{ name }] })).toBeNull()

          expect(await itemOf('attempt', commands.v2.runId)).toStrictEqual(
            v2Item,
          )
          expect(
            (await claimAttempt({ tasks: [{ name, revision: 'v2' }] }))
              ?.command,
          ).toEqual(commands.v2)
        })

        it('keeps activity lanes apart, also for a revision named like an activity', async () => {
          const harness = createHarness()
          const { client, runtime, claimAttempt, route } = harness
          const name = 'lanes.activities'
          const runId = randomUUID()
          const commands = {
            legacyA: activityCommand(runId, name, 'a'),
            legacyStep: activityCommand(runId, name, 'step'),
            v1A: { ...activityCommand(runId, name, 'a'), revision: 'v1' },
            v1B: { ...activityCommand(runId, name, 'b'), revision: 'v1' },
            // Untagged, this revision's route would be the unversioned
            // route of activity `step`.
            stepOther: {
              ...activityCommand(runId, name, 'other'),
              revision: 'step',
            },
          }
          for (const command of Object.values(commands)) {
            await runtime.attemptExecutor.dispatchActivity(command)
          }
          const idOf = async (attemptId: string) => {
            const raw = await client.hget(
              harness.keys.queue('attempt').dedup,
              attemptId,
            )
            return raw!
          }
          expect(
            await client.zrange(
              `${route('attempt', 'activity', part(name), part('step'))}:ready`,
              '0',
              '-1',
            ),
          ).toEqual([await idOf(commands.legacyStep.attemptId)])
          expect(
            await client.zrange(
              `${route('attempt', 'rev:activity', part(name), part('step'))}:ready`,
              '0',
              '-1',
            ),
          ).toEqual([await idOf(commands.stepOther.attemptId)])

          const legacy = [{ name }]
          const v1 = [{ name, revision: 'v1' }]
          const step = [{ name, revision: 'step' }]
          const claim = async (routes: Parameters<typeof claimAttempt>[0]) =>
            (await claimAttempt(routes))?.command

          expect(
            await claim({ workflows: legacy, activityNames: ['step'] }),
          ).toEqual(commands.legacyStep)
          expect(
            await claim({
              workflows: legacy,
              activityNames: ['step', 'other'],
            }),
          ).toBeUndefined()
          expect(
            await claim({ workflows: v1, activityNames: ['step', 'other'] }),
          ).toBeUndefined()
          expect(await claim({ workflows: v1, activityNames: ['b'] })).toEqual(
            commands.v1B,
          )
          expect(
            await claim({ workflows: v1, activityNames: ['b'] }),
          ).toBeUndefined()
          expect(await claim({ workflows: step })).toEqual(commands.stepOther)
          expect(await claim({ workflows: step })).toBeUndefined()
          expect(await claim({ workflows: legacy })).toEqual(commands.legacyA)
          expect(await claim({ workflows: legacy })).toBeUndefined()

          // Still parked, undelivered, for a worker that serves v1's `a`.
          const parked = (await harness.items('attempt')).filter(
            (item) => item.leaseToken === undefined,
          )
          expect(parked).toHaveLength(1)
          expect(parked[0]).toMatchObject({ deliveryCount: 0 })
          expect(parked[0]!.deadAt).toBeUndefined()
          expect(await claim({ workflows: v1 })).toEqual(commands.v1A)
        })

        it('keeps a versioned command in its lane across dead-lettering, requeue and deletion', async () => {
          const harness = createHarness({ maxDeliveries: 1 })
          const { client, runtime, store, claimContinue, claimAttempt, route } =
            harness
          const name = 'lanes.requeued'
          const command = continueCommand(randomUUID(), name, 'v1')
          await runtime.runCoordinationExecutor.enqueue(command)
          const claimed = await claimContinue({ name, revision: 'v1' })
          await runtime.runCoordinationExecutor.release(claimed!, {
            error: new Error('poison'),
          })
          const [dead] = await store.listDeadCommands()
          expect(dead).toMatchObject({ payload: command, deliveryCount: 1 })

          await store.requeueDeadCommand(dead!.id)

          const versioned = `${route('continue', 'rev:workflow', part(name), part('v1'))}:ready`
          const legacy = `${route('continue', 'workflow', part(name))}:ready`
          expect(await client.zrange(versioned, '0', '-1')).toEqual([dead!.id])
          expect(await client.exists(legacy)).toBe(0)
          expect(await claimContinue({ name })).toBeNull()
          expect(
            (await claimContinue({ name, revision: 'v1' }))?.command,
          ).toEqual(command)

          const task = taskCommand(randomUUID(), 'lanes.deleted', 'v1')
          await runtime.attemptExecutor.dispatchTask(task)
          const taskRoute = `${route('attempt', 'rev:task', part('lanes.deleted'), part('v1'))}:ready`
          expect(await client.zcard(taskRoute)).toBe(1)
          expect(
            await runtime.attemptExecutor.deleteUnclaimed({
              runId: task.runId,
            }),
          ).toBe(1)
          expect(await client.exists(taskRoute)).toBe(0)
          expect(
            await claimAttempt({
              tasks: [{ name: 'lanes.deleted', revision: 'v1' }],
            }),
          ).toBeNull()
        })

        it('keeps a versioned command in its lane across a delayed start, a release and the deletion of its family', async () => {
          const harness = createHarness()
          const { client, keyPrefix, runtime, store, claimContinue, route } =
            harness
          const api = createWorkflowRuntimeClient(runtime)
          const name = 'lanes.delayed'
          const versioned = `${route('continue', 'rev:workflow', part(name), part('v1'))}:ready`
          const legacy = `${route('continue', 'workflow', part(name))}:ready`

          const run = await api.start(flow(name, 'v1'), 'in', {
            startAt: Date.now() + 150,
          })

          expect(await client.zcard(versioned)).toBe(1)
          expect(await claimContinue({ name, revision: 'v1' })).toBeNull()
          await wait(200)
          expect(await claimContinue({ name })).toBeNull()
          const claimed = await claimContinue({ name, revision: 'v1' })
          expect(claimed?.command).toEqual(continueCommand(run.id, name, 'v1'))

          await runtime.runCoordinationExecutor.release(claimed!)

          expect(await client.zcard(versioned)).toBe(1)
          expect(await client.exists(legacy)).toBe(0)
          await wait(100)
          expect(await claimContinue({ name })).toBeNull()

          await store.cancelRun({ runId: run.id })
          expect(await store.deleteRun(run.id)).toEqual({ deleted: true })
          expect(await matchingKeys(client, `${keyPrefix}queue:*`)).toEqual([])
        })

        it('runs every run with the code of its own revision, parking what no worker serves', async () => {
          const harness = createHarness()
          const { runtime, itemOf } = harness
          const api = createWorkflowRuntimeClient(runtime)
          const name = 'lanes.end-to-end'
          const definitions = {
            legacy: flow(name),
            v1: flow(name, 'v1'),
            v2: flow(name, 'v2'),
          }
          const base = {
            ...runtime,
            tasks: [],
            workerId: 'lanes',
            reaping: false,
            runTimeouts: false,
          } as const
          const serve = async (...tags: (keyof typeof definitions)[]) => {
            const workers = {
              ...base,
              workflows: tags.map((tag) => implement(definitions[tag], tag)),
            }
            for (let pass = 0; pass < 3; pass += 1) {
              await runWorkflowWorker(workers)
              await runExecutionWorker(workers)
            }
          }
          const runs = {
            legacy: await api.start(definitions.legacy, 'in'),
            v1: await api.start(definitions.v1, 'in'),
            v2: await api.start(definitions.v2, 'in'),
          }
          const outcome = async (tag: keyof typeof runs) => {
            const { run } = (await api.get(runs[tag].id))!
            return run.status === 'completed' ? run.output : run.status
          }
          const parked = await itemOf('continue', runs.v1.id)

          await serve('legacy', 'v2')

          expect(await outcome('legacy')).toBe('in-legacy')
          expect(await outcome('v2')).toBe('in-v2')
          expect(await outcome('v1')).toBe('queued')
          expect(await itemOf('continue', runs.v1.id)).toStrictEqual(parked)

          // Deploying the missing revision is all the parked run needs.
          await serve('v1')
          expect(await outcome('v1')).toBe('in-v1')
        })
      })

      describe('manual retry', () => {
        it('reopens a versioned workflow run onto its own lane without changing what it is pinned to', async () => {
          const harness = createHarness()
          const { runtime, store, claimContinue } = harness
          const api = createWorkflowRuntimeClient(runtime)
          const name = 'retried.flow'
          const started = await api.start(flow(name, 'v1'), 'in')
          const first = await claimContinue({ name, revision: 'v1' })
          await runtime.runCoordinationExecutor.ack(first!)
          const failed = await store.failRun({
            runId: started.id,
            error: new Error('failed'),
          })

          const reopened = await store.reopenFailedRun({
            runId: started.id,
            expectedVersion: failed!.version,
          })

          expect(reopened).toMatchObject({
            status: 'queued',
            executionRevision: 'v1',
            graphHash: describeDefinition(flow(name)).graphHash,
          })
          expect(await claimContinue({ name })).toBeNull()
          expect(
            (await claimContinue({ name, revision: 'v1' }))?.command,
          ).toEqual(continueCommand(started.id, name, 'v1'))
        })

        it('starts and reopens a versioned task run on its own lane', async () => {
          const harness = createHarness()
          const { runtime, store, claimAttempt } = harness
          const api = createWorkflowRuntimeClient(runtime)
          const name = 'retried.task'
          const task = defineTask({
            name,
            revision: 'v1',
            input: text,
            output: text,
          })
          const started = await api.start(task, 'in')
          expect(await claimAttempt({ tasks: [{ name }] })).toBeNull()
          const first = await claimAttempt({
            tasks: [{ name, revision: 'v1' }],
          })
          expect(first?.command).toMatchObject({
            kind: 'taskAttempt',
            taskName: name,
            revision: 'v1',
            runId: started.id,
          })
          await store.failCurrentAttempt({
            attemptId: first!.command.attemptId,
            leaseToken: first!.command.leaseToken,
            error: new Error('failed'),
          })
          await runtime.attemptExecutor.ack(first!)
          const failed = await store.failRun({
            runId: started.id,
            error: new Error('failed'),
          })

          const reopened = await store.reopenFailedRun({
            runId: started.id,
            expectedVersion: failed!.version,
          })

          expect(reopened).toMatchObject({
            status: 'queued',
            executionRevision: 'v1',
          })
          expect(await claimAttempt({ tasks: [{ name }] })).toBeNull()
          const retried = await claimAttempt({
            tasks: [{ name, revision: 'v1' }],
          })
          expect(retried?.command).toMatchObject({
            kind: 'taskAttempt',
            taskName: name,
            revision: 'v1',
            runId: started.id,
            input: first!.command.input,
          })
          expect(retried!.command.attemptId).not.toBe(first!.command.attemptId)
        })
      })

      describe('retention', () => {
        it('keeps shared graphs and revisions when the families using them expire, are deleted or pruned', async () => {
          const harness = createHarness({ terminalRetentionMs: 300 })
          const { client, keys, store } = harness
          const definition = defineWorkflow({
            name: 'kept.flow',
            revision: 'v1',
            input: text,
            output: text,
            title: 'Kept',
          })
            .activity('step', { input: text, output: text })
            .build()
          const { graphHash } = describeDefinition(definition)
          const expired = await store.createRun(runOf(definition))
          const running = await store.createRun(runOf(definition))
          const shared = {
            graphs: await client.hgetall(keys.graphs()),
            revisions: await client.hgetall(keys.revisions()),
          }
          const definitions = async () => ({
            graphs: await client.hgetall(keys.graphs()),
            revisions: await client.hgetall(keys.revisions()),
          })
          // Not among the keys a family expires or deletes with itself.
          const meta = await client.hgetall(keys.family(expired.id))
          expect(meta.externalKeys).not.toContain('definitions:')
          expect(keys.familyStateKeys(expired.id)).not.toContain(keys.graphs())

          await store.completeRun({ runId: expired.id, output: 'done' })

          expect(await client.pttl(keys.family(expired.id))).toBeGreaterThan(0)
          expect(await store.loadGraphPresentation(expired.id)).toStrictEqual({
            title: 'Kept',
          })
          expect(await client.pttl(keys.graphs())).toBe(-1)
          expect(await client.pttl(keys.revisions())).toBe(-1)
          await expect
            .poll(() => client.exists(keys.family(expired.id)), {
              timeout: 3_000,
            })
            .toBe(0)

          // The labels went with the family; what another family still uses
          // did not.
          expect(await store.loadGraphPresentation(expired.id)).toBeUndefined()
          expect(await definitions()).toStrictEqual(shared)
          expect(await store.loadGraphPresentation(running.id)).toStrictEqual({
            title: 'Kept',
          })

          await store.completeRun({ runId: running.id, output: 'done' })
          expect(await store.deleteRun(running.id)).toEqual({ deleted: true })
          const pruned = await store.createRun(runOf(definition))
          await store.completeRun({ runId: pruned.id, output: 'done' })
          expect(
            await store.pruneTerminalRuns({ olderThan: Date.now() + 60_000 }),
          ).toMatchObject({ deleted: 1 })

          // Used by no run at all now, and still there, without a TTL.
          expect((await store.listRuns()).runs).toEqual([])
          expect(await definitions()).toStrictEqual(shared)
          expect(await client.pttl(keys.graphs())).toBe(-1)
          expect(await client.pttl(keys.revisions())).toBe(-1)
          expect(await store.loadGraph(graphHash)).toStrictEqual({
            graphHash,
            structure: projectStructure(definition),
          })
          const later = await store.createRun({
            workflowName: definition.name,
            input: 'in',
            executionRevision: 'v1',
            graphHash,
          })
          expect(later.executionRevision).toBe('v1')
        })
      })

      describe('data written before revisions existed', () => {
        const legacyFlow = defineWorkflow({
          name: 'legacy.flow',
          input: z.object({ a: z.number(), list: z.array(z.string()) }),
          output: text,
        })
          .activity('step', { input: text, output: text })
          .build()
        async function seed({ client, keyPrefix }: Harness) {
          for (const [name, entry] of Object.entries(headData.keys)) {
            const key = `${keyPrefix}${name}`
            const scoped = (value: string) =>
              value.replaceAll('{prefix}', keyPrefix)
            if (entry.type === 'string') {
              await client.set(key, scoped(entry.value))
            } else if (entry.type === 'set') {
              await client.sadd(key, ...entry.value)
            } else if (entry.type === 'zset') {
              for (let index = 0; index < entry.value.length; index += 2) {
                await client.zadd(
                  key,
                  entry.value[index + 1]!,
                  entry.value[index]!,
                )
              }
            } else {
              for (const [field, value] of Object.entries(entry.value)) {
                await client.hset(key, scoped(field), scoped(value))
              }
            }
          }
          return headData.ids
        }

        it('reads the runs and lists them in the unversioned lane only', async () => {
          const harness = createHarness()
          const { store } = harness
          const ids = await seed(harness)

          const snapshot = await store.loadRunSnapshot(ids.root)
          expect(snapshot!.run).toMatchObject({
            id: ids.root,
            name: 'legacy.flow',
            status: 'queued',
            input: { a: 1, list: [] },
            idempotencyKey: ['legacy', 1],
            tags: { team: 'x' },
          })
          expect(snapshot!.run).not.toHaveProperty('executionRevision')
          expect(snapshot!.run).not.toHaveProperty('graphHash')
          expect(snapshot!.nodes.map((node) => node.name)).toEqual([
            'step',
            'sub',
          ])
          expect(await store.loadGraphPresentation(ids.root)).toBeUndefined()

          const all = Object.values(ids).filter((id) => id !== ids.attempt)
          const unversioned = await store.listRuns({ executionRevision: null })
          expect(unversioned.runs.map((run) => run.id).sort()).toEqual(
            all.sort(),
          )
          expect(
            (await store.listRuns({ executionRevision: 'v1' })).runs,
          ).toEqual([])
          const [dead] = await store.listDeadCommands()
          expect(dead).toMatchObject({
            runId: ids.dead,
            deliveryCount: 1,
            lastError: { message: 'boom' },
          })
        })

        it('claims the commands on the unversioned lane only, at the keys they were indexed under', async () => {
          const harness = createHarness()
          const { client, keyPrefix, claimContinue, claimAttempt } = harness
          const ids = await seed(harness)

          expect(
            await claimContinue({ name: 'legacy.flow', revision: 'v1' }),
          ).toBeNull()
          expect(
            await claimAttempt({
              workflows: [{ name: 'legacy.flow', revision: 'v1' }],
              tasks: [{ name: 'legacy.task', revision: 'v1' }],
            }),
          ).toBeNull()

          const continuation = await claimContinue({ name: 'legacy.flow' })
          expect(continuation?.command).toStrictEqual({
            kind: 'continueRun',
            runId: ids.root,
            workflowName: 'legacy.flow',
          })
          const activity = await claimAttempt({
            workflows: [{ name: 'legacy.flow' }],
            activityNames: ['step'],
          })
          expect(activity?.command).toMatchObject({
            kind: 'activityAttempt',
            attemptId: ids.attempt,
            activityName: 'step',
            input: 'in',
          })
          const task = await claimAttempt({ tasks: [{ name: 'legacy.task' }] })
          expect(task?.command).toMatchObject({
            kind: 'taskAttempt',
            runId: ids.task,
          })
          expect(task!.command).not.toHaveProperty('revision')

          // Claimed where the old binary indexed them, and nowhere new.
          expect(
            await client.zcard(
              `${keyPrefix}queue:continue:route:workflow:11:legacy.flow:claimed`,
            ),
          ).toBe(1)
          expect(
            await client.zcard(
              `${keyPrefix}queue:attempt:route:activity:11:legacy.flow:4:step:claimed`,
            ),
          ).toBe(1)
          expect(
            await matchingKeys(client, `${keyPrefix}queue:*:route:rev:*`),
          ).toEqual([])
        })

        it('reclaims an expired lease in place and requeues a dead command onto the unversioned lane', async () => {
          const harness = createHarness()
          const { client, keyPrefix, runtime, store, claimContinue, itemOf } =
            harness
          const ids = await seed(harness)
          const stale = await runtime.runCoordinationExecutor.claim({
            workerId: 'crashed',
            workflows: [{ name: 'legacy.flow' }],
            leaseMs: 1,
          })
          await wait(25)

          const taken = await claimContinue({ name: 'legacy.flow' })

          expect(taken?.command).toStrictEqual(stale!.command)
          expect(await itemOf('continue', ids.root)).toMatchObject({
            deliveryCount: 1,
            payload: {
              kind: 'continueRun',
              runId: ids.root,
              workflowName: 'legacy.flow',
            },
          })

          const [dead] = await store.listDeadCommands()
          await store.requeueDeadCommand(dead!.id)
          expect(
            await claimContinue({ name: 'legacy.dead', revision: 'v1' }),
          ).toBeNull()
          expect(
            (await claimContinue({ name: 'legacy.dead' }))?.command,
          ).toStrictEqual({
            kind: 'continueRun',
            runId: ids.dead,
            workflowName: 'legacy.dead',
          })
          expect(
            await matchingKeys(client, `${keyPrefix}queue:*:route:rev:*`),
          ).toEqual([])
        })

        it('replays a root start and a child by their stored signatures', async () => {
          const harness = createHarness()
          const { runtime, store, dump } = harness
          const ids = await seed(harness)
          const api = createWorkflowRuntimeClient(runtime)
          const before = await dump()

          const replay = await api.start(
            legacyFlow,
            { a: 1, list: [] },
            { idempotencyKey: ['legacy', 1] },
          )
          const child = await store.ensureChildRun({
            runId: ids.root,
            nodeName: 'sub',
            childKey: '$self',
            childKind: 'workflow',
            childName: 'legacy.child',
            input: ['x'],
            rootRunId: ids.root,
            ...childRunDefinitionInput({}, flow('legacy.child')),
          })

          expect(replay.id).toBe(ids.root)
          expect(child.created).toBe(false)
          expect(child.childRun.id).toBe(ids.child)
          // Replays start nothing, and save no graph for a run that has none.
          expect(await dump()).toStrictEqual(before)

          const refused = await store
            .createRun({
              ...runOf(flow('legacy.flow', 'v1'), { a: 1, list: [] }),
              idempotencyKey: ['legacy', 1],
            })
            .catch((error: unknown) => error)
          expect(refused).toBeInstanceOf(WorkflowIdempotencyConflictError)
          expect(refused).toMatchObject({ runId: ids.root })
          await expect(
            store.ensureChildRun({
              runId: ids.root,
              nodeName: 'sub',
              childKey: '$self',
              childKind: 'workflow',
              childName: 'legacy.child',
              input: ['x'],
              rootRunId: ids.root,
              ...childRunDefinitionInput({}, flow('legacy.child', 'v1')),
            }),
          ).rejects.toThrow(`Conflicting child run [${ids.root}.sub.$self]`)
        })

        it('retries a failed run manually onto the unversioned lane', async () => {
          const harness = createHarness()
          const { store, claimContinue } = harness
          const ids = await seed(harness)
          const failed = await store.failRun({
            runId: ids.dead,
            error: new Error('failed'),
          })

          const reopened = await store.reopenFailedRun({
            runId: ids.dead,
            expectedVersion: failed!.version,
          })

          expect(reopened.status).toBe('queued')
          expect(reopened).not.toHaveProperty('executionRevision')
          expect(
            await claimContinue({ name: 'legacy.dead', revision: 'v1' }),
          ).toBeNull()
          expect(
            (await claimContinue({ name: 'legacy.dead' }))?.command,
          ).toStrictEqual({
            kind: 'continueRun',
            runId: ids.dead,
            workflowName: 'legacy.dead',
          })
        })

        it('finishes a task run with the unversioned implementation', async () => {
          const harness = createHarness()
          const { runtime } = harness
          const ids = await seed(harness)
          const api = createWorkflowRuntimeClient(runtime)
          const workers = {
            ...runtime,
            workflows: [],
            workerId: 'upgraded',
            reaping: false,
            runTimeouts: false,
          } as const
          const implementation = (revision?: string) =>
            implementTask(
              defineTask({
                name: 'legacy.task',
                revision,
                input: text,
                output: text,
              }),
              {
                pool: 'test',
                handler: async (input) => `${input}-${revision ?? 'legacy'}`,
              },
            )

          // A versioned implementation of the same name is not its code.
          await runExecutionWorker({
            ...workers,
            tasks: [implementation('v1')],
          })
          expect((await api.get(ids.task))!.run.status).toBe('queued')

          await runExecutionWorker({ ...workers, tasks: [implementation()] })

          const { run } = (await api.get(ids.task))!
          expect(run).toMatchObject({
            status: 'completed',
            output: 'in-legacy',
          })
        })
      })

      describe('commands a binary without revision routing left behind', () => {
        it('never executes a versioned run from the unversioned lane', async () => {
          const harness = createHarness()
          const { runtime, store, itemOf } = harness
          const name = 'guard.flow'
          const run = await store.createRun(runOf(flow(name, 'v1')))
          // What such a binary enqueues to wake, cancel or retry this run.
          await runtime.runCoordinationExecutor.enqueue(
            continueCommand(run.id, name),
          )
          let executed = 0
          const implementation = implementWorkflow(flow(name), { pool: 'test' })
            .step(async (input) => {
              executed += 1
              return input
            })
            .finish(({ step }) => step)
          const workers = {
            ...runtime,
            workflows: [implementation],
            tasks: [],
            workerId: 'guard',
            reaping: false,
            runTimeouts: false,
          } as const

          await runWorkflowWorker(workers)
          await runExecutionWorker(workers)

          expect(executed).toBe(0)
          const snapshot = await store.loadRunSnapshot(run.id)
          expect(snapshot!.run.status).toBe('queued')
          expect(snapshot!.nodes).toEqual([])
          const item = await itemOf('continue', run.id)
          expect(item.deliveryCount).toBe(1)
          expect(item.lastError).toContain(
            `Run [${run.id}] does not match command route [${name}]`,
          )
        })

        it('takes a revision-less pending command back to its lane on the next wake-up of its run', async () => {
          const harness = createHarness()
          const { client, runtime, store, claimContinue, route } = harness
          const name = 'guard.woken'
          const run = await store.createRun(runOf(flow(name, 'v1')))
          await runtime.runCoordinationExecutor.enqueue(
            continueCommand(run.id, name),
          )

          await runtime.runCoordinationExecutor.enqueue(
            continueCommand(run.id, name, 'v1'),
          )

          const pending = await harness.items('continue')
          expect(pending).toHaveLength(1)
          const [item] = pending
          expect(item!.payload).toStrictEqual(
            continueCommand(run.id, name, 'v1'),
          )
          expect(
            await client.exists(
              `${route('continue', 'workflow', part(name))}:ready`,
            ),
          ).toBe(0)
          expect(await claimContinue({ name })).toBeNull()
          expect(
            (await claimContinue({ name, revision: 'v1' }))?.command,
          ).toEqual(continueCommand(run.id, name, 'v1'))
        })

        it('moves a versioned command found on an unversioned route back to its own', async () => {
          const harness = createHarness()
          const { client, runtime, claimContinue, itemOf, route } = harness
          const name = 'guard.moved'
          const command = continueCommand(randomUUID(), name, 'v1')
          await runtime.runCoordinationExecutor.enqueue(command)
          const item = await itemOf('continue', command.runId)
          const versioned = `${route('continue', 'rev:workflow', part(name), part('v1'))}:ready`
          const legacy = `${route('continue', 'workflow', part(name))}:ready`
          // Such a binary requeues a dead command by name alone.
          const score = await client.zscore(versioned, item.id)
          await client.zrem(versioned, item.id)
          await client.zadd(legacy, score!, item.id)

          expect(await claimContinue({ name })).toBeNull()

          expect(await client.zrange(legacy, '0', '-1')).toEqual([])
          expect(await client.zrange(versioned, '0', '-1')).toEqual([item.id])
          expect(await itemOf('continue', command.runId)).toStrictEqual(item)
          expect(
            (await claimContinue({ name, revision: 'v1' }))?.command,
          ).toEqual(command)
        })

        it('moves an expired versioned lease found on an unversioned route back to its own', async () => {
          const harness = createHarness()
          const { client, runtime, claimContinue, itemOf, route } = harness
          const name = 'guard.leased'
          const command = continueCommand(randomUUID(), name, 'v1')
          await runtime.runCoordinationExecutor.enqueue(command)
          await runtime.runCoordinationExecutor.claim({
            workerId: 'crashed',
            workflows: [{ name, revision: 'v1' }],
            leaseMs: 1,
          })
          await wait(25)
          const leased = await itemOf('continue', command.runId)
          const versioned = `${route('continue', 'rev:workflow', part(name), part('v1'))}:claimed`
          const legacy = `${route('continue', 'workflow', part(name))}:claimed`
          const score = await client.zscore(versioned, leased.id)
          await client.zrem(versioned, leased.id)
          await client.zadd(legacy, score!, leased.id)

          expect(await claimContinue({ name })).toBeNull()

          // Not taken over, and so not counted, by a worker that cannot run it.
          expect(await itemOf('continue', command.runId)).toStrictEqual(leased)
          expect(await client.zrange(legacy, '0', '-1')).toEqual([])
          expect(await client.zrange(versioned, '0', '-1')).toEqual([leased.id])
          expect(
            (await claimContinue({ name, revision: 'v1' }))?.command,
          ).toEqual(command)
          expect(await itemOf('continue', command.runId)).toMatchObject({
            deliveryCount: 1,
          })
        })
      })
    },
  )
}

type HeadEntry =
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'hash'; readonly value: Readonly<Record<string, string>> }
  | { readonly type: 'set' | 'zset'; readonly value: readonly string[] }

/**
 * Every key the adapter wrote before revisions existed, captured by running
 * that code (commit 83074f22) against a real server: a root workflow run with
 * an idempotency key, a dispatched activity attempt and a linked child run,
 * all started atomically; a task run; and a run whose continuation was
 * dead-lettered. `{prefix}` stands for the runtime's key prefix.
 */
const headData: {
  readonly ids: Readonly<
    Record<'root' | 'child' | 'task' | 'dead' | 'attempt', string>
  >
  readonly keys: Readonly<Record<string, HeadEntry>>
} = {
  ids: {
    root: 'f1a55a4c-6b94-4dc0-92b6-0b1809dcd302',
    child: 'efb8e1e7-c081-4ada-aa58-94c6709fb545',
    task: '04f65566-b931-44e9-b4b4-32f7e5b6f3db',
    dead: '84585cce-e941-4c55-b253-83b8fdb834d4',
    attempt: 'e5882678-662f-4752-a139-c6837969b842',
  },
  keys: {
    'attempt-root:59f39bcd-04ed-478b-b381-23859b6d9103': {
      type: 'string',
      value: '04f65566-b931-44e9-b4b4-32f7e5b6f3db',
    },
    'attempt-root:e5882678-662f-4752-a139-c6837969b842': {
      type: 'string',
      value: 'f1a55a4c-6b94-4dc0-92b6-0b1809dcd302',
    },
    'family:04f65566-b931-44e9-b4b4-32f7e5b6f3db': {
      type: 'hash',
      value: {
        externalKeys:
          '["{prefix}run-root:04f65566-b931-44e9-b4b4-32f7e5b6f3db","{prefix}start-dispatch:04f65566-b931-44e9-b4b4-32f7e5b6f3db","{prefix}attempt-root:59f39bcd-04ed-478b-b381-23859b6d9103"]',
        nonTerminalCount: '1',
        'owner:{prefix}attempt-root:59f39bcd-04ed-478b-b381-23859b6d9103':
          '04f65566-b931-44e9-b4b4-32f7e5b6f3db',
        'owner:{prefix}run-root:04f65566-b931-44e9-b4b4-32f7e5b6f3db':
          '04f65566-b931-44e9-b4b4-32f7e5b6f3db',
        'owner:{prefix}start-dispatch:04f65566-b931-44e9-b4b4-32f7e5b6f3db':
          '1',
        rootRunId: '04f65566-b931-44e9-b4b4-32f7e5b6f3db',
        runIds: '["04f65566-b931-44e9-b4b4-32f7e5b6f3db"]',
      },
    },
    'family:04f65566-b931-44e9-b4b4-32f7e5b6f3db:attempts': {
      type: 'hash',
      value: {
        '59f39bcd-04ed-478b-b381-23859b6d9103':
          '{"leaseToken":"bcd0824e-683e-4de6-a2c1-3f63d7bf04b6","id":"59f39bcd-04ed-478b-b381-23859b6d9103","nodeName":"$task","dispatchedAt":1791895358602,"retryAttemptNumber":1,"input":"\\"in\\"","status":"started","attemptNumber":1,"runId":"04f65566-b931-44e9-b4b4-32f7e5b6f3db","childKey":"$self"}',
      },
    },
    'family:04f65566-b931-44e9-b4b4-32f7e5b6f3db:children': {
      type: 'hash',
      value: {
        '04f65566-b931-44e9-b4b4-32f7e5b6f3db\u0000$task\u0000$self':
          '{"currentAttemptId":"59f39bcd-04ed-478b-b381-23859b6d9103","updatedAt":1791895358602,"nodeName":"$task","createdAt":1791895358602,"attemptCount":1,"version":2,"childKey":"$self","status":"running","kind":"task","runId":"04f65566-b931-44e9-b4b4-32f7e5b6f3db","ordinal":0}',
      },
    },
    'family:04f65566-b931-44e9-b4b4-32f7e5b6f3db:indexes': {
      type: 'hash',
      value: {
        'attempts:04f65566-b931-44e9-b4b4-32f7e5b6f3db\u0000$task':
          '["59f39bcd-04ed-478b-b381-23859b6d9103"]',
        'children:04f65566-b931-44e9-b4b4-32f7e5b6f3db\u0000$task':
          '["04f65566-b931-44e9-b4b4-32f7e5b6f3db\\u0000$task\\u0000$self"]',
        'nodes:04f65566-b931-44e9-b4b4-32f7e5b6f3db':
          '["04f65566-b931-44e9-b4b4-32f7e5b6f3db\\u0000$task"]',
      },
    },
    'family:04f65566-b931-44e9-b4b4-32f7e5b6f3db:nodes': {
      type: 'hash',
      value: {
        '04f65566-b931-44e9-b4b4-32f7e5b6f3db\u0000$task':
          '{"version":3,"createdAt":1791895358599,"name":"$task","kind":"task","input":"\\"in\\"","updatedAt":1791895358602,"runId":"04f65566-b931-44e9-b4b4-32f7e5b6f3db","status":"running"}',
      },
    },
    'family:04f65566-b931-44e9-b4b4-32f7e5b6f3db:orders': {
      type: 'hash',
      value: {
        '04f65566-b931-44e9-b4b4-32f7e5b6f3db': '3',
      },
    },
    'family:04f65566-b931-44e9-b4b4-32f7e5b6f3db:runs': {
      type: 'hash',
      value: {
        '04f65566-b931-44e9-b4b4-32f7e5b6f3db':
          '{"id":"04f65566-b931-44e9-b4b4-32f7e5b6f3db","kind":"task","name":"legacy.task","workflowName":"legacy.task","status":"queued","input":"\\"in\\"","rootRunId":"04f65566-b931-44e9-b4b4-32f7e5b6f3db","tags":"{}","version":1,"activeSince":1791895358598,"createdAt":1791895358598,"updatedAt":1791895358598,"taskName":"legacy.task"}',
      },
    },
    'family:04f65566-b931-44e9-b4b4-32f7e5b6f3db:signatures': {
      type: 'hash',
      value: {
        '04f65566-b931-44e9-b4b4-32f7e5b6f3db':
          '["task","legacy.task","legacy.task","legacy.task",null,null,null,null,"in"]',
      },
    },
    'family:84585cce-e941-4c55-b253-83b8fdb834d4': {
      type: 'hash',
      value: {
        externalKeys:
          '["{prefix}run-root:84585cce-e941-4c55-b253-83b8fdb834d4","{prefix}start-dispatch:84585cce-e941-4c55-b253-83b8fdb834d4"]',
        nonTerminalCount: '1',
        'owner:{prefix}run-root:84585cce-e941-4c55-b253-83b8fdb834d4':
          '84585cce-e941-4c55-b253-83b8fdb834d4',
        'owner:{prefix}start-dispatch:84585cce-e941-4c55-b253-83b8fdb834d4':
          '1',
        rootRunId: '84585cce-e941-4c55-b253-83b8fdb834d4',
        runIds: '["84585cce-e941-4c55-b253-83b8fdb834d4"]',
      },
    },
    'family:84585cce-e941-4c55-b253-83b8fdb834d4:orders': {
      type: 'hash',
      value: {
        '84585cce-e941-4c55-b253-83b8fdb834d4': '4',
      },
    },
    'family:84585cce-e941-4c55-b253-83b8fdb834d4:runs': {
      type: 'hash',
      value: {
        '84585cce-e941-4c55-b253-83b8fdb834d4':
          '{"id":"84585cce-e941-4c55-b253-83b8fdb834d4","kind":"workflow","name":"legacy.dead","workflowName":"legacy.dead","status":"queued","input":"null","rootRunId":"84585cce-e941-4c55-b253-83b8fdb834d4","tags":"{}","version":1,"activeSince":1791895358604,"createdAt":1791895358604,"updatedAt":1791895358604}',
      },
    },
    'family:84585cce-e941-4c55-b253-83b8fdb834d4:signatures': {
      type: 'hash',
      value: {
        '84585cce-e941-4c55-b253-83b8fdb834d4':
          '["workflow","legacy.dead","legacy.dead",null,null,null,null,null,null]',
      },
    },
    'family:f1a55a4c-6b94-4dc0-92b6-0b1809dcd302': {
      type: 'hash',
      value: {
        externalKeys:
          '["{prefix}run-root:f1a55a4c-6b94-4dc0-92b6-0b1809dcd302","{prefix}start-dispatch:f1a55a4c-6b94-4dc0-92b6-0b1809dcd302","{prefix}idempotency:1sTl8nLyQ3v8SYOS8qZGZRjHgIh3ZxNIFF6bC0s3uzM","{prefix}attempt-root:e5882678-662f-4752-a139-c6837969b842","{prefix}run-root:efb8e1e7-c081-4ada-aa58-94c6709fb545","{prefix}start-dispatch:efb8e1e7-c081-4ada-aa58-94c6709fb545"]',
        nonTerminalCount: '2',
        'owner:{prefix}attempt-root:e5882678-662f-4752-a139-c6837969b842':
          'f1a55a4c-6b94-4dc0-92b6-0b1809dcd302',
        'owner:{prefix}idempotency:1sTl8nLyQ3v8SYOS8qZGZRjHgIh3ZxNIFF6bC0s3uzM':
          'f1a55a4c-6b94-4dc0-92b6-0b1809dcd302',
        'owner:{prefix}run-root:efb8e1e7-c081-4ada-aa58-94c6709fb545':
          'f1a55a4c-6b94-4dc0-92b6-0b1809dcd302',
        'owner:{prefix}run-root:f1a55a4c-6b94-4dc0-92b6-0b1809dcd302':
          'f1a55a4c-6b94-4dc0-92b6-0b1809dcd302',
        'owner:{prefix}start-dispatch:efb8e1e7-c081-4ada-aa58-94c6709fb545':
          '1',
        'owner:{prefix}start-dispatch:f1a55a4c-6b94-4dc0-92b6-0b1809dcd302':
          '1',
        rootRunId: 'f1a55a4c-6b94-4dc0-92b6-0b1809dcd302',
        runIds:
          '["f1a55a4c-6b94-4dc0-92b6-0b1809dcd302","efb8e1e7-c081-4ada-aa58-94c6709fb545"]',
      },
    },
    'family:f1a55a4c-6b94-4dc0-92b6-0b1809dcd302:attempts': {
      type: 'hash',
      value: {
        'e5882678-662f-4752-a139-c6837969b842':
          '{"leaseToken":"5e53ec64-f957-4939-acbb-f3f0dd62023c","id":"e5882678-662f-4752-a139-c6837969b842","nodeName":"step","dispatchedAt":1791895358593,"retryAttemptNumber":1,"input":"\\"in\\"","status":"started","attemptNumber":1,"runId":"f1a55a4c-6b94-4dc0-92b6-0b1809dcd302","childKey":"$self"}',
      },
    },
    'family:f1a55a4c-6b94-4dc0-92b6-0b1809dcd302:children': {
      type: 'hash',
      value: {
        'f1a55a4c-6b94-4dc0-92b6-0b1809dcd302\u0000step\u0000$self':
          '{"currentAttemptId":"e5882678-662f-4752-a139-c6837969b842","updatedAt":1791895358593,"nodeName":"step","createdAt":1791895358592,"attemptCount":1,"version":2,"childKey":"$self","status":"running","kind":"activity","runId":"f1a55a4c-6b94-4dc0-92b6-0b1809dcd302","ordinal":0}',
        'f1a55a4c-6b94-4dc0-92b6-0b1809dcd302\u0000sub\u0000$self':
          '{"childRunId":"efb8e1e7-c081-4ada-aa58-94c6709fb545","updatedAt":1791895358597,"nodeName":"sub","createdAt":1791895358596,"attemptCount":0,"version":2,"childKey":"$self","status":"running","kind":"workflow","runId":"f1a55a4c-6b94-4dc0-92b6-0b1809dcd302","ordinal":0}',
      },
    },
    'family:f1a55a4c-6b94-4dc0-92b6-0b1809dcd302:indexes': {
      type: 'hash',
      value: {
        'attempts:f1a55a4c-6b94-4dc0-92b6-0b1809dcd302\u0000step':
          '["e5882678-662f-4752-a139-c6837969b842"]',
        'children:f1a55a4c-6b94-4dc0-92b6-0b1809dcd302\u0000step':
          '["f1a55a4c-6b94-4dc0-92b6-0b1809dcd302\\u0000step\\u0000$self"]',
        'children:f1a55a4c-6b94-4dc0-92b6-0b1809dcd302\u0000sub':
          '["f1a55a4c-6b94-4dc0-92b6-0b1809dcd302\\u0000sub\\u0000$self"]',
        'nodes:f1a55a4c-6b94-4dc0-92b6-0b1809dcd302':
          '["f1a55a4c-6b94-4dc0-92b6-0b1809dcd302\\u0000step","f1a55a4c-6b94-4dc0-92b6-0b1809dcd302\\u0000sub"]',
      },
    },
    'family:f1a55a4c-6b94-4dc0-92b6-0b1809dcd302:nodes': {
      type: 'hash',
      value: {
        'f1a55a4c-6b94-4dc0-92b6-0b1809dcd302\u0000step':
          '{"createdAt":1791895358590,"name":"step","updatedAt":1791895358593,"status":"running","kind":"activity","runId":"f1a55a4c-6b94-4dc0-92b6-0b1809dcd302","version":2}',
        'f1a55a4c-6b94-4dc0-92b6-0b1809dcd302\u0000sub':
          '{"runId":"f1a55a4c-6b94-4dc0-92b6-0b1809dcd302","name":"sub","kind":"workflow","status":"pending","version":1,"createdAt":1791895358595,"updatedAt":1791895358595}',
      },
    },
    'family:f1a55a4c-6b94-4dc0-92b6-0b1809dcd302:orders': {
      type: 'hash',
      value: {
        'efb8e1e7-c081-4ada-aa58-94c6709fb545': '2',
        'f1a55a4c-6b94-4dc0-92b6-0b1809dcd302': '1',
      },
    },
    'family:f1a55a4c-6b94-4dc0-92b6-0b1809dcd302:runs': {
      type: 'hash',
      value: {
        'efb8e1e7-c081-4ada-aa58-94c6709fb545':
          '{"id":"efb8e1e7-c081-4ada-aa58-94c6709fb545","kind":"workflow","name":"legacy.child","workflowName":"legacy.child","status":"queued","input":"[\\"x\\"]","rootRunId":"f1a55a4c-6b94-4dc0-92b6-0b1809dcd302","tags":"{}","version":1,"activeSince":1791895358597,"createdAt":1791895358597,"updatedAt":1791895358597,"parentRunId":"f1a55a4c-6b94-4dc0-92b6-0b1809dcd302","parentNodeName":"sub"}',
        'f1a55a4c-6b94-4dc0-92b6-0b1809dcd302':
          '{"id":"f1a55a4c-6b94-4dc0-92b6-0b1809dcd302","kind":"workflow","name":"legacy.flow","workflowName":"legacy.flow","status":"queued","input":"{\\"a\\":1,\\"list\\":[]}","rootRunId":"f1a55a4c-6b94-4dc0-92b6-0b1809dcd302","tags":"{\\"team\\":\\"x\\"}","version":1,"activeSince":1791895358575,"createdAt":1791895358575,"updatedAt":1791895358575,"idempotencyKey":"[\\"legacy\\",1]"}',
      },
    },
    'family:f1a55a4c-6b94-4dc0-92b6-0b1809dcd302:signatures': {
      type: 'hash',
      value: {
        'efb8e1e7-c081-4ada-aa58-94c6709fb545':
          '["workflow","legacy.child","legacy.child",null,"f1a55a4c-6b94-4dc0-92b6-0b1809dcd302","sub","f1a55a4c-6b94-4dc0-92b6-0b1809dcd302",null,["x"]]',
        'f1a55a4c-6b94-4dc0-92b6-0b1809dcd302':
          '["workflow","legacy.flow","legacy.flow",null,null,null,null,["legacy",1],{"a":1,"list":[]}]',
      },
    },
    'idempotency:1sTl8nLyQ3v8SYOS8qZGZRjHgIh3ZxNIFF6bC0s3uzM': {
      type: 'string',
      value: 'f1a55a4c-6b94-4dc0-92b6-0b1809dcd302',
    },
    'queue:attempt:dedup': {
      type: 'hash',
      value: {
        '59f39bcd-04ed-478b-b381-23859b6d9103':
          '617f0cbb-0c55-431a-9cde-f88cc4c0382d',
        'e5882678-662f-4752-a139-c6837969b842':
          '0d66591a-d042-4453-b518-0423380a64d1',
      },
    },
    'queue:attempt:items': {
      type: 'hash',
      value: {
        '0d66591a-d042-4453-b518-0423380a64d1':
          '{"createdAt":1791895358594,"payload":{"workflowName":"legacy.flow","attemptId":"e5882678-662f-4752-a139-c6837969b842","activityName":"step","nodeName":"step","leaseToken":"5e53ec64-f957-4939-acbb-f3f0dd62023c","input":"\\"in\\"","kind":"activityAttempt","runId":"f1a55a4c-6b94-4dc0-92b6-0b1809dcd302","childKey":"$self"},"id":"0d66591a-d042-4453-b518-0423380a64d1","rootRunId":"f1a55a4c-6b94-4dc0-92b6-0b1809dcd302","deliveryCount":0,"createdAtScore":1791895358594}',
        '617f0cbb-0c55-431a-9cde-f88cc4c0382d':
          '{"createdAt":1791895358603,"payload":{"workflowName":"legacy.task","attemptId":"59f39bcd-04ed-478b-b381-23859b6d9103","taskName":"legacy.task","nodeName":"$task","leaseToken":"bcd0824e-683e-4de6-a2c1-3f63d7bf04b6","input":"\\"in\\"","kind":"taskAttempt","runId":"04f65566-b931-44e9-b4b4-32f7e5b6f3db","childKey":"$self"},"id":"617f0cbb-0c55-431a-9cde-f88cc4c0382d","rootRunId":"04f65566-b931-44e9-b4b4-32f7e5b6f3db","deliveryCount":0,"createdAtScore":1791895358603}',
      },
    },
    'queue:attempt:ready': {
      type: 'zset',
      value: [
        '0d66591a-d042-4453-b518-0423380a64d1',
        '1791895358594',
        '617f0cbb-0c55-431a-9cde-f88cc4c0382d',
        '1791895358603',
      ],
    },
    'queue:attempt:route:activity:11:legacy.flow:4:step:ready': {
      type: 'zset',
      value: ['0d66591a-d042-4453-b518-0423380a64d1', '1791895358594'],
    },
    'queue:attempt:route:activity:11:legacy.flow:ready': {
      type: 'zset',
      value: ['0d66591a-d042-4453-b518-0423380a64d1', '1791895358594'],
    },
    'queue:attempt:route:task:11:legacy.task:ready': {
      type: 'zset',
      value: ['617f0cbb-0c55-431a-9cde-f88cc4c0382d', '1791895358603'],
    },
    'queue:attempt:run:04f65566-b931-44e9-b4b4-32f7e5b6f3db': {
      type: 'set',
      value: ['617f0cbb-0c55-431a-9cde-f88cc4c0382d'],
    },
    'queue:attempt:run:f1a55a4c-6b94-4dc0-92b6-0b1809dcd302': {
      type: 'set',
      value: ['0d66591a-d042-4453-b518-0423380a64d1'],
    },
    'queue:continue:dead': {
      type: 'zset',
      value: ['70886855-65f5-47b6-8bad-7a5e2188fe0c', '1791895358608'],
    },
    'queue:continue:dedup': {
      type: 'hash',
      value: {
        '84585cce-e941-4c55-b253-83b8fdb834d4':
          '70886855-65f5-47b6-8bad-7a5e2188fe0c',
        'f1a55a4c-6b94-4dc0-92b6-0b1809dcd302':
          '0eeaa247-0c83-4a48-bb15-00839eea9352',
      },
    },
    'queue:continue:items': {
      type: 'hash',
      value: {
        '0eeaa247-0c83-4a48-bb15-00839eea9352':
          '{"createdAt":1791895358588,"payload":{"kind":"continueRun","runId":"f1a55a4c-6b94-4dc0-92b6-0b1809dcd302","workflowName":"legacy.flow"},"id":"0eeaa247-0c83-4a48-bb15-00839eea9352","rootRunId":"f1a55a4c-6b94-4dc0-92b6-0b1809dcd302","deliveryCount":0,"createdAtScore":1791895358588}',
        '70886855-65f5-47b6-8bad-7a5e2188fe0c':
          '{"deadAt":1791895358608,"id":"70886855-65f5-47b6-8bad-7a5e2188fe0c","rootRunId":"84585cce-e941-4c55-b253-83b8fdb834d4","createdAtScore":1791895358604,"lastError":"{\\"name\\":\\"Error\\",\\"message\\":\\"boom\\",\\"stack\\":\\"Error: boom\\\\n    at start (worker.ts:1:1)\\"}","payload":{"kind":"continueRun","runId":"84585cce-e941-4c55-b253-83b8fdb834d4","workflowName":"legacy.dead"},"runAtScore":1791895358708,"runAt":1791895358708,"createdAt":1791895358604,"deliveryCount":1}',
      },
    },
    'queue:continue:ready': {
      type: 'zset',
      value: ['0eeaa247-0c83-4a48-bb15-00839eea9352', '1791895358588'],
    },
    'queue:continue:route:workflow:11:legacy.flow:ready': {
      type: 'zset',
      value: ['0eeaa247-0c83-4a48-bb15-00839eea9352', '1791895358588'],
    },
    'queue:continue:run:84585cce-e941-4c55-b253-83b8fdb834d4': {
      type: 'set',
      value: ['70886855-65f5-47b6-8bad-7a5e2188fe0c'],
    },
    'queue:continue:run:f1a55a4c-6b94-4dc0-92b6-0b1809dcd302': {
      type: 'set',
      value: ['0eeaa247-0c83-4a48-bb15-00839eea9352'],
    },
    'run-root:04f65566-b931-44e9-b4b4-32f7e5b6f3db': {
      type: 'string',
      value: '04f65566-b931-44e9-b4b4-32f7e5b6f3db',
    },
    'run-root:84585cce-e941-4c55-b253-83b8fdb834d4': {
      type: 'string',
      value: '84585cce-e941-4c55-b253-83b8fdb834d4',
    },
    'run-root:efb8e1e7-c081-4ada-aa58-94c6709fb545': {
      type: 'string',
      value: 'f1a55a4c-6b94-4dc0-92b6-0b1809dcd302',
    },
    'run-root:f1a55a4c-6b94-4dc0-92b6-0b1809dcd302': {
      type: 'string',
      value: 'f1a55a4c-6b94-4dc0-92b6-0b1809dcd302',
    },
    'runs:active': {
      type: 'zset',
      value: [
        'f1a55a4c-6b94-4dc0-92b6-0b1809dcd302',
        '1',
        'efb8e1e7-c081-4ada-aa58-94c6709fb545',
        '2',
        '04f65566-b931-44e9-b4b4-32f7e5b6f3db',
        '3',
        '84585cce-e941-4c55-b253-83b8fdb834d4',
        '4',
      ],
    },
    'runs:ordered': {
      type: 'zset',
      value: [
        'f1a55a4c-6b94-4dc0-92b6-0b1809dcd302',
        '1',
        'efb8e1e7-c081-4ada-aa58-94c6709fb545',
        '2',
        '04f65566-b931-44e9-b4b4-32f7e5b6f3db',
        '3',
        '84585cce-e941-4c55-b253-83b8fdb834d4',
        '4',
      ],
    },
    'runs:sequence': {
      type: 'string',
      value: '4',
    },
    'start-dispatch:04f65566-b931-44e9-b4b4-32f7e5b6f3db': {
      type: 'string',
      value: '1',
    },
    'start-dispatch:f1a55a4c-6b94-4dc0-92b6-0b1809dcd302': {
      type: 'string',
      value: '1',
    },
  },
}
