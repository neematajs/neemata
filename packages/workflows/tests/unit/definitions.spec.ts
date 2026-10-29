import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { DefinitionRecord, Mutation } from '../../src/index.ts'
import {
  Client,
  describeDefinition,
  InMemory,
  Store,
  task,
  workflow,
} from '../../src/index.ts'

const text = Schema.String
const io = { pool: 'test', input: text, output: text }

/** `flow@v1` over one task, the workflow's steps as given. */
function declare(steps: readonly string[] = ['work']) {
  const Work = task({
    ...io,
    name: 'work',
    revision: 'v1',
    handler: (input) => Effect.succeed(input),
  })
  const Flow = workflow(
    { ...io, name: 'flow', revision: 'v1', title: 'Flow' },
    function* (w) {
      for (const step of steps) yield* w.task(step, Work, { input: w.input })
      return w.input
    },
  )
  return { Work, Flow }
}

const keyOf = (kind: string, name: string) =>
  `revision:${JSON.stringify([kind, name, 'v1'])}`

describe('what a declaration carries for the engine', () => {
  it('is its graph hash, its labels and the records of its closure', () => {
    const { Work, Flow } = declare()
    const flow = describeDefinition(Flow)
    const work = describeDefinition(Work)

    expect(Flow.program.definition).toStrictEqual({
      graphHash: flow.graphHash,
      presentation: { title: 'Flow' },
      records: [
        { key: `graph:${flow.graphHash}`, value: flow.structure },
        { key: `graph:${work.graphHash}`, value: work.structure },
        { key: keyOf('task', 'work'), value: work.manifest },
        { key: keyOf('workflow', 'flow'), value: flow.manifest },
      ],
    })
    // A step names its target's description, which is the target's own.
    expect(Flow.program.steps).toMatchObject([{ task: { name: 'work' } }])
    const [step] = Flow.program.steps
    expect(step!.kind === 'task' && step.task.definition).toBe(
      Work.program.definition,
    )
  })

  it('is its own graph alone without a revision', () => {
    const Pinned = declare().Work
    const Loose = workflow({ ...io, name: 'loose' }, function* (w) {
      return yield* w.task('work', Pinned, { input: w.input })
    })
    const { graphHash, structure } = describeDefinition(Loose)

    // Nothing pins what it references: the child brings its own records.
    expect(Loose.program.definition).toStrictEqual({
      graphHash,
      records: [{ key: `graph:${graphHash}`, value: structure }],
    })
  })
})

describe('saving definitions', () => {
  it.effect('saves the closure of a revision once, however many runs', () => {
    const { Flow } = declare()
    const commits: Mutation[] = []
    const memory = InMemory.makeInMemoryStore({
      beforeCommit: (mutation) => commits.push(mutation),
    })

    return Effect.provideService(
      Effect.gen(function* () {
        yield* Client.start(Flow, 'a')
        yield* Client.start(Flow, 'b')

        expect(commits.map(({ definitions }) => definitions)).toStrictEqual([
          Flow.program.definition!.records,
          [],
        ])
        expect(Array.from(memory.inspect.definitions())).toStrictEqual(
          Flow.program.definition!.records.map(({ key, value }) => [
            key,
            value,
          ]),
        )
      }),
      Store,
      memory.store,
    )
  })

  it.effect(
    'plans a start again when another saves the same definitions first',
    () => {
      const { Flow } = declare()
      const saved: (readonly DefinitionRecord[])[] = []
      let raced = false
      const memory = InMemory.makeInMemoryStore({
        beforeCommit({ definitions = [] }) {
          saved.push(definitions)
          if (raced) return
          raced = true
          Effect.runSync(
            Effect.provideService(Client.start(Flow, 'b'), Store, memory.store),
          )
        },
      })

      return Effect.provideService(
        Effect.gen(function* () {
          yield* Client.start(Flow, 'a')

          // The first plan would have saved them; the winner did, and the
          // plan that ran again found them saved.
          expect(saved.map((records) => records.length)).toStrictEqual([
            4, 4, 0,
          ])
          expect(memory.inspect.runs()).toHaveLength(2)
          expect(memory.inspect.definitions().size).toBe(4)
        }),
        Store,
        memory.store,
      )
    },
  )

  it.effect(
    'refuses a start when another saves its revision with another graph first',
    () => {
      const { Flow } = declare()
      const other = declare(['work', 'again']).Flow
      let raced = false
      const memory = InMemory.makeInMemoryStore({
        beforeCommit() {
          if (raced) return
          raced = true
          Effect.runSync(
            Effect.provideService(
              Client.start(other, 'b'),
              Store,
              memory.store,
            ),
          )
        },
      })

      return Effect.provideService(
        Effect.gen(function* () {
          const refused = yield* Effect.flip(Client.start(Flow, 'a'))

          expect(refused).toMatchObject({
            _tag: 'DefinitionConflict',
            message: expect.stringContaining(
              'workflow [flow@v1] is already saved',
            ),
          })
          expect(memory.inspect.runs()).toMatchObject([
            { run: { graphHash: describeDefinition(other).graphHash } },
          ])
          // What is saved is the winner's, whole.
          expect(
            memory.inspect.definitions().get(keyOf('workflow', 'flow')),
          ).toStrictEqual(describeDefinition(other).manifest)
        }),
        Store,
        memory.store,
      )
    },
  )
})

describe('the in-memory store', () => {
  const record = { key: 'graph:abc', value: { name: 'first' } }
  const write = (
    definitions: readonly DefinitionRecord[],
    loaded: readonly string[] = definitions.map(({ key }) => key),
  ) =>
    Effect.flatMap(Store, (store) =>
      store.transact({ definitions: loaded }, () => ({
        _tag: 'Commit',
        mutation: { definitions },
        result: undefined,
      })),
    )
  const read = (key: string) =>
    Effect.flatMap(Store, (store) =>
      store.transact({ definitions: [key] }, ({ definitions }) => ({
        _tag: 'Commit',
        mutation: {},
        result: { loaded: definitions.has(key), value: definitions.get(key) },
      })),
    )

  it.effect('loads a definition and the absence of one', () =>
    Effect.provide(
      Effect.gen(function* () {
        expect(yield* read(record.key)).toStrictEqual({
          loaded: true,
          value: undefined,
        })
        yield* write([record])
        expect(yield* read(record.key)).toStrictEqual({
          loaded: true,
          value: record.value,
        })
      }),
      InMemory.layer(),
    ),
  )

  it.effect('never replaces a saved definition, or saves one unread', () =>
    Effect.provide(
      Effect.gen(function* () {
        yield* write([record])

        const replaced = yield* Effect.exit(
          write([{ ...record, value: { name: 'second' } }]),
        )
        expect(String(replaced)).toContain(
          'Definition [graph:abc] is already saved',
        )
        const unread = yield* Effect.exit(
          write([{ key: 'graph:def', value: {} }], []),
        )
        expect(String(unread)).toContain(
          'Unguarded write to [definition:graph:def]',
        )

        expect(yield* read(record.key)).toMatchObject({ value: record.value })
        expect(yield* read('graph:def')).toMatchObject({ value: undefined })
      }),
      InMemory.layer(),
    ),
  )
})
