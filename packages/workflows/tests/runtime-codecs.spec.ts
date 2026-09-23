import { PGlite } from '@electric-sql/pglite'
import * as Context from 'effect/Context'
import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'
import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
  runExecutionWorker,
  runWorkflowWorker,
} from '../src/effect/index.ts'
import { defineSchedule } from '../src/index.ts'
import { decodeNodeOutput } from '../src/runtime/codec.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  isTerminalRunStatus,
} from '../src/runtime/index.ts'
import { fromPromise } from './support/effect.ts'

const at = '2026-09-20T10:00:00.000Z'
const payload = Schema.Struct({
  at: Schema.DateFromString,
  count: Schema.NumberFromString,
})
const native = Schema.Struct({ at: Schema.Date, count: Schema.Number })
const encoded = { at, count: '7' }
const decoded = { at: new Date(at), count: 7 }

for (const adapter of ['memory', 'postgres'] as const) {
  describe(`${adapter} durable codecs`, () => {
    let database: PGlite | undefined
    afterEach(async () => {
      await database?.close()
    })

    async function setup() {
      const context = Context.empty()
      if (adapter === 'memory')
        return { ...createInMemoryWorkflowRuntime(), context }
      database = new PGlite()
      const connection = createPostgresWorkflowConnection(database)
      await installPostgresWorkflowSchemaForTesting(connection)
      return { ...createPostgresWorkflowRuntime({ connection }), context }
    }

    it('resumes parallel children without output schemas after serialization', async () => {
      const runtime = await setup()
      const child = defineWorkflow({
        name: 'untyped-parallel-child',
        input: Schema.String,
      }).build()
      const childImpl = implementWorkflow(child).finish(() =>
        fromPromise(() => undefined),
      )
      const workflow = defineWorkflow({
        name: 'untyped-parallel-parent',
        input: Schema.String,
        output: Schema.String,
      })
        .parallel('members', (h) => ({
          a: h.workflow(child),
          b: h.workflow(child),
        }))
        .activity('pause', { input: Schema.String, output: Schema.String })
        .build()
      const impl = implementWorkflow(workflow)
        .members((h) => ({ a: h.workflow(child), b: h.workflow(child) }))
        .pause((input) => fromPromise(async () => input))
        .finish(({ members, pause }) =>
          fromPromise(() => {
            expect(members.a).toBeUndefined()
            expect(members.b).toBeUndefined()
            return pause
          }),
        )
      const client = createWorkflowRuntimeClient(runtime)
      const run = await client.start(workflow, 'done')
      const workers = {
        ...runtime,
        workflows: [impl, childImpl],
        workerId: 'codec-worker',
      }
      await runWorkflowWorker(workers)
      const waiting = (await client.get(run.id))!
      expect(waiting.nodes.find(({ name }) => name === 'members')?.status).toBe(
        'completed',
      )
      expect(waiting.run.status).not.toBe('completed')
      // A fresh continuation reads the aggregate back from the store. PostgreSQL
      // has dropped the undefined member keys by this point.
      await runExecutionWorker({ ...workers, tasks: [] })
      await runWorkflowWorker(workers)
      expect((await client.get(run.id))?.run).toMatchObject({
        status: 'completed',
        output: 'done',
      })
    })

    it('resumes mapped children without output schemas after serialization', async () => {
      const runtime = await setup()
      const child = defineWorkflow({
        name: 'untyped-map-child',
        input: Schema.String,
      }).build()
      const childImpl = implementWorkflow(child).finish(() =>
        fromPromise(() => undefined),
      )
      const workflow = defineWorkflow({
        name: 'untyped-map-parent',
        input: Schema.String,
        output: Schema.String,
      })
        .mapWorkflow('items', child, { item: Schema.String })
        .activity('pause', { input: Schema.String, output: Schema.String })
        .build()
      const impl = implementWorkflow(workflow)
        .items(child, {
          items: () => ['a', 'b'],
          input: (_outputs, item) => item,
        })
        .pause((input) => fromPromise(async () => input))
        .finish(({ items, pause }) =>
          fromPromise(() => {
            expect(
              items.items.map(({ item, output }) => ({ item, output })),
            ).toEqual([
              { item: 'a', output: undefined },
              { item: 'b', output: undefined },
            ])
            return pause
          }),
        )
      const client = createWorkflowRuntimeClient(runtime)
      const run = await client.start(workflow, 'done')
      const workers = {
        ...runtime,
        workflows: [impl, childImpl],
        workerId: 'codec-worker',
      }
      await runWorkflowWorker(workers)
      const waiting = (await client.get(run.id))!
      expect(waiting.nodes.find(({ name }) => name === 'items')?.status).toBe(
        'completed',
      )
      expect(waiting.run.status).not.toBe('completed')
      await runExecutionWorker({ ...workers, tasks: [] })
      await runWorkflowWorker(workers)
      expect((await client.get(run.id))?.run).toMatchObject({
        status: 'completed',
        output: 'done',
      })
    })

    it.each(['activity', 'task', 'workflow'] as const)(
      'restores every node boundary with a %s branch',
      async (selected) => {
        const runtime = await setup()
        const task = defineTask({
          name: 'codec-task',
          input: payload,
          output: payload,
        })
        const taskImpl = implementTask(task, {
          handler: (input) =>
            fromPromise(async () => {
              expect(input).toEqual(decoded)
              return input
            }),
        })
        const child = defineWorkflow({
          name: 'codec-child',
          input: payload,
          output: payload,
        }).build()
        const childImpl = implementWorkflow(child).finish((_outputs, input) =>
          fromPromise(() => {
            expect(input).toEqual(decoded)
            return input
          }),
        )
        const workflow = defineWorkflow({
          name: 'codec-parent',
          input: payload,
          output: payload,
          tags: (input) => ({ at: input.at.toISOString() }),
          idempotency: (input) => [input.count],
        })
          .activity('first', { input: payload, output: payload })
          .task('directTask', task)
          .workflow('directWorkflow', child)
          .branch('choice', {
            output: native,
            cases: (h) => ({
              activity: h.activity({ input: payload, output: native }),
              task: h.task(task),
              workflow: h.workflow(child),
            }),
          })
          .parallel('members', (h) => ({
            activity: h.activity({ input: payload, output: native }),
            task: h.task(task),
            workflow: h.workflow(child),
          }))
          .mapTask('tasks', task, {
            item: Schema.DateFromString,
            concurrency: 1,
          })
          .mapWorkflow('workflows', child, {
            item: Schema.DateFromString,
            concurrency: 1,
          })
          .build()
        let firstCalls = 0
        const impl = implementWorkflow(workflow)
          .first((input) =>
            fromPromise(async () => {
              firstCalls++
              expect(input).toEqual(decoded)
              return input
            }),
          )
          .directTask(task, { input: ({ first }) => first })
          .directWorkflow(child, {
            input: ({ directTask }) => directTask,
          })
          .choice({
            select: ({ directWorkflow }) => {
              expect(directWorkflow).toEqual(decoded)
              return selected
            },
            cases: (h) => ({
              activity: h.activity((input) => fromPromise(async () => input)),
              task: h.task(task),
              workflow: h.workflow(child),
            }),
          })
          .members((h) => ({
            activity: h.activity((input) => fromPromise(async () => input), {
              input: ({ choice }) => choice,
            }),
            task: h.task(task),
            workflow: h.workflow(child),
          }))
          .tasks(task, {
            items: ({ members }) => {
              expect(Object.values(members)).toEqual([
                decoded,
                decoded,
                decoded,
              ])
              return [decoded.at, decoded.at]
            },
            input: (_outputs, item) => {
              expect(item).toEqual(decoded.at)
              return { at: item, count: 7 }
            },
            idempotency: (_outputs, item, _input, index) => [
              item.toISOString(),
              index,
            ],
          })
          .workflows(child, {
            items: ({ tasks }) => tasks.items.map(({ item }) => item),
            input: (_outputs, item) => ({
              at: item,
              count: 7,
            }),
          })
          .finish((outputs, input) =>
            fromPromise(() => {
              expect(input).toEqual(decoded)
              expect(outputs.choice).toEqual(decoded)
              for (const map of [outputs.tasks, outputs.workflows]) {
                expect(
                  map.items.map(({ item, output }) => ({ item, output })),
                ).toEqual([
                  { item: decoded.at, output: decoded },
                  { item: decoded.at, output: decoded },
                ])
              }
              return input
            }),
          )
        const client = createWorkflowRuntimeClient({
          ...runtime,
          definitions: [workflow],
        })
        const run = await client.start(workflow, decoded)
        expect(run.input).toEqual(decoded)
        expect(run.tags).toEqual({ at })
        expect(run.idempotencyKey).toEqual([7])

        // Separate drain calls recreate execution/coordination state. Postgres
        // serializes all payloads between them, including queued commands.
        for (let pass = 0; pass < 20; pass++) {
          await runWorkflowWorker({
            ...runtime,
            workflows: [impl, childImpl],
            workerId: `coordinator-${pass}`,
          })
          const snapshot = await client.get(run.id)
          if (snapshot && isTerminalRunStatus(snapshot.run.status)) break
          await runExecutionWorker({
            ...runtime,
            workflows: [impl, childImpl],
            tasks: [taskImpl],
            workerId: `executor-${pass}`,
          })
        }
        const snapshot = (await client.get(run.id))!
        expect(snapshot.run.status).toBe('completed')
        expect(firstCalls).toBe(1)
        expect(snapshot.run.input).toEqual(encoded)
        expect(snapshot.run.output).toEqual(encoded)
        expect(
          snapshot.nodes.find(({ name }) => name === 'first')?.output,
        ).toEqual(encoded)
        expect(
          snapshot.nodes.find(({ name }) => name === 'members')?.output,
        ).toEqual({
          activity: { at, count: 7 },
          task: encoded,
          workflow: encoded,
        })
        const mapped = snapshot.children.filter(
          ({ nodeName }) => nodeName === 'tasks',
        )
        expect(mapped.map(({ item }) => item)).toEqual([at, at])
        const children = await runtime.store.loadRuns(
          mapped.map(({ childRunId }) => childRunId!),
        )
        expect(
          children.map(({ input, output }) => ({ input, output })),
        ).toEqual([
          { input: encoded, output: encoded },
          { input: encoded, output: encoded },
        ])
      },
    )

    it('restarts tasks and workflows whose authored encoding is not JSON', async () => {
      const runtime = await setup()
      const task = defineTask({
        name: 'native-date-task',
        input: Schema.Date,
        output: Schema.Date,
      })
      const taskImpl = implementTask(task, {
        handler: (input) =>
          fromPromise(async () => {
            expect(input).toEqual(decoded.at)
            return input
          }),
      })
      const workflow = defineWorkflow({
        name: 'native-date-workflow',
        input: Schema.Date,
        output: Schema.Date,
      }).build()
      const impl = implementWorkflow(workflow).finish((_outputs, input) =>
        fromPromise(() => {
          expect(input).toEqual(decoded.at)
          return input
        }),
      )
      const client = createWorkflowRuntimeClient({
        ...runtime,
        definitions: [task, workflow],
      })
      const execute = async () => {
        await runExecutionWorker({
          ...runtime,
          tasks: [taskImpl],
          workflows: [],
          workerId: 'executor',
        })
        await runWorkflowWorker({
          ...runtime,
          workflows: [impl],
          workerId: 'coordinator',
        })
      }
      const taskRun = await client.start(task, decoded.at)
      const workflowRun = await client.start(workflow, decoded.at)
      await execute()
      for (const run of [taskRun, workflowRun]) {
        expect((await client.get(run.id))?.run.output).toBe(at)
        const restarted = await client.restart(run.id)
        expect(restarted.id).not.toBe(run.id)
        expect(restarted.input).toEqual(decoded.at)
        await execute()
        expect((await client.get(restarted.id))?.run).toMatchObject({
          status: 'completed',
          input: at,
          output: at,
        })
      }
      // A uniqueness join must decode the stored run, including its output.
      const joined = await client.start(task, decoded.at, {
        unique: { key: ['date'], scope: 'all', behavior: 'join' },
      })
      await execute()
      const again = await client.start(task, new Date('2020-01-01'), {
        unique: { key: ['date'], scope: 'all', behavior: 'join' },
      })
      expect(again).toMatchObject({
        id: joined.id,
        input: decoded.at,
        output: decoded.at,
      })
    })

    it('preserves memoized outputs and encoded inputs across automatic and manual retries', async () => {
      const runtime = await setup()
      const workflow = defineWorkflow({
        name: 'codec-retry',
        input: payload,
        output: payload,
      })
        .activity('saved', { input: payload, output: payload })
        .activity('retried', {
          input: payload,
          output: payload,
          retry: { attempts: 2 },
        })
        .build()
      let saved = 0
      let mappings = 0
      let attempts = 0
      let fail = true
      const impl = implementWorkflow(workflow)
        .saved((input) =>
          fromPromise(async () => {
            saved++
            return input
          }),
        )
        .retried(
          (input) =>
            fromPromise(async () => {
              attempts++
              expect(input).toEqual(decoded)
              if (fail) throw new Error('retry me')
              return input
            }),
          {
            input: ({ saved }) => {
              mappings++
              return saved
            },
          },
        )
        .finish(({ retried }) => fromPromise(() => retried))
      const client = createWorkflowRuntimeClient({
        ...runtime,
        definitions: [workflow],
      })
      const run = await client.start(workflow, decoded)
      const drain = async () => {
        for (let pass = 0; pass < 3; pass++) {
          await runWorkflowWorker({
            ...runtime,
            workflows: [impl],
            workerId: 'coordinator',
          })
          await runExecutionWorker({
            ...runtime,
            workflows: [impl],
            tasks: [],
            workerId: 'executor',
          })
        }
      }
      await drain()
      const before = (await client.get(run.id))!
      expect(before.run.status).toBe('failed')
      expect(attempts).toBe(2)
      fail = false
      await client.retry(run.id, { expectedVersion: before.run.version })
      await drain()
      const after = (await client.get(run.id))!
      expect(after.run).toMatchObject({
        status: 'completed',
        input: encoded,
        output: encoded,
      })
      expect({ saved, mappings, attempts }).toEqual({
        saved: 1,
        mappings: 1,
        attempts: 3,
      })
      expect(
        after.attempts.every(
          ({ input }) => JSON.stringify(input) === JSON.stringify(encoded),
        ),
      ).toBe(true)
    })

    it('stores scheduled input encoded while deriving tags from decoded values', async () => {
      const runtime = await setup()
      const task = defineTask({
        name: 'scheduled-codec-task',
        input: payload,
        output: payload,
        tags: (input) => ({ at: input.at.toISOString() }),
      })
      const impl = implementTask(task, {
        handler: (input) =>
          fromPromise(async () => {
            expect(input).toEqual(decoded)
            return input
          }),
      })
      await runtime.scheduler!.reconcile([
        defineSchedule({
          name: 'codec-schedule',
          runnable: task,
          input: decoded,
          every: '1h',
        }),
      ])
      expect((await runtime.scheduler!.list())[0]).toMatchObject({
        input: encoded,
        tags: { at },
      })
      const run = await runtime.scheduler!.trigger('codec-schedule')
      await runExecutionWorker({
        ...runtime,
        tasks: [impl],
        workflows: [],
        workerId: 'executor',
      })
      expect((await runtime.store.loadRuns([run.id]))[0]).toMatchObject({
        status: 'completed',
        input: encoded,
        output: encoded,
      })
    })

    it('distinguishes JSON null from absent payloads through resumption', async () => {
      const runtime = await setup()
      const task = defineTask({
        name: 'void-task',
        input: Schema.Undefined,
        output: Schema.Null,
      })
      const taskImpl = implementTask(task, {
        handler: (input) =>
          fromPromise(async () => {
            expect(input).toBeUndefined()
            return null
          }),
      })
      const workflow = defineWorkflow({
        name: 'void-workflow',
        input: Schema.String,
        output: Schema.Undefined,
      })
        .activity('nil', { input: Schema.Undefined, output: Schema.Null })
        .activity('void', { input: Schema.Null, output: Schema.Undefined })
        .task('task', task)
        .build()
      let mappings = 0
      const impl = implementWorkflow(workflow)
        .nil(
          (input) =>
            fromPromise(async () => {
              expect(input).toBeUndefined()
              return null
            }),
          {
            input: () => {
              mappings++
              return undefined
            },
          },
        )
        .void(
          (input) =>
            fromPromise(async () => {
              expect(input).toBeNull()
              return undefined
            }),
          { input: ({ nil }) => nil },
        )
        .task(task, { input: ({ void: value }) => value })
        .finish((outputs) =>
          fromPromise(() => {
            expect(outputs).toEqual({ nil: null, void: undefined, task: null })
            return undefined
          }),
        )
      const client = createWorkflowRuntimeClient(runtime)
      const run = await client.start(workflow, 'root')
      for (let pass = 0; pass < 4; pass++) {
        await runWorkflowWorker({
          ...runtime,
          workflows: [impl],
          workerId: 'coordinator',
        })
        // Duplicate delivery before execution must not re-run a null-valued binding.
        await runtime.runCoordinationExecutor.enqueue({
          kind: 'continueRun',
          runId: run.id,
          workflowName: workflow.name,
        })
        await runWorkflowWorker({
          ...runtime,
          workflows: [impl],
          workerId: 'coordinator',
        })
        await runExecutionWorker({
          ...runtime,
          workflows: [impl],
          tasks: [taskImpl],
          workerId: 'executor',
        })
      }
      const snapshot = (await client.get(run.id))!
      expect(snapshot.run).toMatchObject({ status: 'completed', output: null })
      expect(mappings).toBe(1)
      expect(
        snapshot.nodes.map(({ input, output }) => ({ input, output })),
      ).toEqual([
        { input: null, output: null },
        { input: null, output: null },
        { input: null, output: null },
      ])
      const node = await runtime.store.loadNodeSnapshot({
        runId: run.id,
        nodeName: 'nil',
      })
      expect(node?.node).toMatchObject({ input: null, output: null })
      expect(node?.attempts[0]).toMatchObject({ input: null, output: null })
      expect(
        (await runtime.store.listRuns()).runs.find(({ id }) => id === run.id),
      ).toHaveProperty('output', null)
    })

    it('fails non-JSON untyped output without committing a lossy value', async () => {
      const runtime = await setup()
      const workflow = defineWorkflow({
        name: 'untyped-codec-output',
        input: Schema.String,
      }).build()
      const impl = implementWorkflow(workflow).finish(() =>
        fromPromise(() => new Date(at)),
      )
      const client = createWorkflowRuntimeClient(runtime)
      const run = await client.start(workflow, 'input')
      await runWorkflowWorker({
        ...runtime,
        workflows: [impl],
        workerId: 'coordinator',
      })
      expect((await client.get(run.id))?.run).toMatchObject({
        status: 'failed',
        error: { message: 'Invalid workflow output [untyped-codec-output]' },
      })
    })
  })
}

it('requires declared output fields after a JSON round trip', () => {
  const child = defineWorkflow({
    name: 'required-child',
    input: Schema.String,
    output: Schema.String,
  }).build()
  const workflow = defineWorkflow({
    name: 'required-outputs',
    input: Schema.String,
  })
    .parallel('members', (h) => ({ child: h.workflow(child) }))
    .mapWorkflow('items', child, { item: Schema.String })
    .build()
  const parallel = JSON.parse(JSON.stringify({ child: undefined }))
  const mapped = JSON.parse(
    JSON.stringify({
      items: [{ item: 'a', index: 0, runId: 'child-run', output: undefined }],
    }),
  )
  expect(() => decodeNodeOutput(workflow.nodes[0]!, parallel)).toThrow(
    'Invalid node output [members]',
  )
  expect(() => decodeNodeOutput(workflow.nodes[1]!, mapped)).toThrow(
    'Invalid node output [items]',
  )
})
