import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { AnyTask, ServedWorkflow } from '../src/index.ts'
import { Client, durable, task } from '../src/index.ts'
import { coordinate, deployment, serve } from './typed-support.ts'

const Prompt = task({
  name: 'inputs.prompt',
  revision: 'v1',
  pool: 'default',
  input: Schema.String,
  output: Schema.String,
  handler: (step) => Effect.succeed(`question ${step}`),
})

const Answer = Schema.Struct({ text: Schema.String })

/**
 * A session of steps from its input: each publishes a prompt and waits for
 * the answer to it, opened together so an answer sent as soon as the prompt
 * is out finds the wait there.
 */
const Session = durable(
  {
    name: 'inputs.session',
    revision: 'v1',
    pool: 'default',
    input: Schema.Struct({
      id: Schema.String,
      steps: Schema.Array(Schema.String),
    }),
    output: Schema.Array(Schema.String),
    tasks: [Prompt],
    inputs: { answer: Answer },
    unique: { key: ({ id }) => ['session', id], behavior: 'join' },
  },
  ({ steps }, d) =>
    Effect.forEach(steps, (step) =>
      Effect.all(
        [d.task(`prompt:${step}`, Prompt, step), d.input('answer', step)],
        { concurrency: 'unbounded' },
      ).pipe(Effect.map(([prompt, { text }]) => `${prompt}: ${text}`)),
    ),
)

const Deadline = durable(
  {
    name: 'inputs.deadline',
    revision: 'v1',
    pool: 'default',
    input: Schema.Void,
    output: Schema.String,
    inputs: { approval: Schema.Boolean },
  },
  (_, d) =>
    Effect.map(d.input('approval', 'only', { timeout: '1h' }), (outcome) =>
      outcome._tag === 'TimedOut'
        ? 'expired'
        : outcome.value
          ? 'approved'
          : 'rejected',
    ),
)

const served = (
  ...declared: readonly {
    readonly workflows: readonly ServedWorkflow[]
    readonly tasks: readonly AnyTask[]
  }[]
) => ({
  workflows: [...new Set(declared.flatMap(({ workflows }) => workflows))],
  tasks: [...new Set(declared.flatMap(({ tasks }) => tasks))],
})

const records = (runId: string) =>
  Effect.map(Client.get(runId), (found) => found!)

describe('inputs of durable workflows', () => {
  it.effect('takes an input sent while the run waits for it', () => {
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Session, { id: 's-1', steps: ['a'] })
        yield* serve(served(Session))
        expect((yield* records(run.id)).run.status).toBe('waiting')

        const receipt = yield* Client.send(Session, run.id, 'answer', 'a', {
          text: 'yes',
        })
        expect(receipt).toMatchObject({ input: '@answer:a', duplicate: false })
        yield* serve(served(Session))

        const { run: done } = yield* records(run.id)
        expect(done.status).toBe('completed')
        expect(done.output).toEqual(['question a: yes'])
      }),
    )
  })

  it.effect('keeps an input sent before the run comes to it', () => {
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Session, {
          id: 's-2',
          steps: ['a', 'b'],
        })
        // Both answers before any pass: the second long before its prompt.
        yield* Client.send(Session, run.id, 'answer', 'a', { text: 'one' })
        yield* Client.send(Session, run.id, 'answer', 'b', { text: 'two' })
        yield* serve(served(Session))

        const { run: done } = yield* records(run.id)
        expect(done.output).toEqual(['question a: one', 'question b: two'])
      }),
    )
  })

  it.effect('keeps the first value of an input', () => {
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Session, { id: 's-3', steps: ['a'] })
        yield* Client.send(Session, run.id, 'answer', 'a', { text: 'first' })

        const again = yield* Client.send(Session, run.id, 'answer', 'a', {
          text: 'first',
        })
        expect(again.duplicate).toBe(true)
        const other = yield* Effect.flip(
          Client.send(Session, run.id, 'answer', 'a', { text: 'second' }),
        )
        expect(other).toMatchObject({
          _tag: 'InputRefused',
          reason: 'received',
        })

        yield* serve(served(Session))
        expect((yield* records(run.id)).run.output).toEqual([
          'question a: first',
        ])
        // Its receipt outlives the run.
        const late = yield* Client.send(Session, run.id, 'answer', 'a', {
          text: 'first',
        })
        expect(late.duplicate).toBe(true)
      }),
    )
  })

  it.effect('finds the run by the unique key it holds', () => {
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Session, { id: 's-4', steps: ['a'] })
        const receipt = yield* Client.send(
          Session,
          { unique: ['session', 's-4'] },
          'answer',
          'a',
          { text: 'by key' },
        )
        expect(receipt.runId).toBe(run.id)

        const missing = yield* Effect.flip(
          Client.send(Session, { unique: ['session', 'nope'] }, 'answer', 'a', {
            text: 'lost',
          }),
        )
        expect(missing).toMatchObject({ reason: 'missing' })
      }),
    )
  })

  it.effect('ends the wait for an input at its timeout', () => {
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Deadline, undefined)
        yield* serve(served(Deadline), 61 * 60_000)
        const { run: done } = yield* records(run.id)
        expect(done.output).toBe('expired')

        const closed = yield* Effect.flip(
          Client.send(Deadline, run.id, 'approval', 'only', true),
        )
        expect(closed).toMatchObject({ reason: 'closed' })
      }),
    )
  })

  it.effect('refuses an input past its time before any pass finds it', () => {
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Deadline, undefined)
        // The run waits; then its time passes with no coordinator running.
        yield* coordinate(Deadline.workflows)
        yield* coordinate([], 61 * 60_000)
        const closed = yield* Effect.flip(
          Client.send(Deadline, run.id, 'approval', 'only', true),
        )
        expect(closed).toMatchObject({ reason: 'closed' })
        yield* serve(served(Deadline))
        expect((yield* records(run.id)).run.output).toBe('expired')
      }),
    )
  })

  it.effect('takes an input sent before its timeout', () => {
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Deadline, undefined)
        yield* serve(served(Deadline), 30 * 60_000)
        yield* Client.send(Deadline, run.id, 'approval', 'only', true)
        yield* serve(served(Deadline))
        expect((yield* records(run.id)).run.output).toBe('approved')
      }),
    )
  })

  it.effect('refuses what no waiting run can take', () => {
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Session, { id: 's-5', steps: ['a'] })
        yield* serve(served(Session))

        // A run of another workflow.
        const missing = yield* Effect.flip(
          Client.send(Session, 'no-such-run', 'answer', 'a', { text: 'x' }),
        )
        expect(missing).toMatchObject({ reason: 'missing' })
        const other = yield* Effect.flip(
          Client.send(Deadline, run.id, 'approval', 'x', true),
        )
        expect(other).toMatchObject({ reason: 'other' })

        yield* Client.cancel(run.id)
        yield* serve(served(Session))
        const ended = yield* Effect.flip(
          Client.send(Session, run.id, 'answer', 'a', { text: 'late' }),
        )
        expect(ended).toMatchObject({ reason: 'ended' })
      }),
    )
  })

  it.effect('keeps inputs apart from operations of the same name', () => {
    const Noted = durable(
      {
        name: 'inputs.noted',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.String,
        tasks: [Prompt],
        inputs: { note: Answer },
      },
      (_, d) =>
        Effect.gen(function* () {
          // The same text as the input's family and key, and another node.
          const prompt = yield* d.task('note:a', Prompt, 'a')
          const { text } = yield* d.input('note', 'a')
          return `${prompt}: ${text}`
        }),
    )
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Noted, undefined)
        yield* Client.send(Noted, run.id, 'note', 'a', { text: 'kept' })
        yield* serve(served(Noted))
        expect((yield* records(run.id)).run.output).toBe('question a: kept')
      }),
    )
  })

  it('refuses operation names the engine keeps for its own nodes', () => {
    const Engine = durable(
      {
        name: 'inputs.engine-name',
        revision: 'v1',
        pool: 'default',
        input: Schema.Void,
        output: Schema.Number,
      },
      (_, d) => d.now('@answer:a'),
    )
    const outcome = Engine.program.replay({
      input: undefined,
      node: () => undefined,
    })
    expect(outcome.outcome).toMatchObject({ _tag: 'Failed' })
  })

  it.effect('refuses a task run that shares the workflow name', () => {
    const Twin = task({
      name: Session.name,
      revision: Session.revision,
      pool: 'default',
      input: Schema.Void,
      output: Schema.Void,
      handler: () => Effect.never,
    })
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Twin, undefined)
        const other = yield* Effect.flip(
          Client.send(Session, run.id, 'answer', 'a', { text: 'x' }),
        )
        expect(other).toMatchObject({
          reason: 'other',
          found: { kind: 'task', name: Session.name },
        })
      }),
    )
  })

  it.effect("encodes for the run's own revision", () => {
    // One family, stored as text by v1 and as a number by v2.
    const options = {
      name: 'inputs.scored',
      pool: 'default',
      input: Schema.Void,
      output: Schema.Number,
    } as const
    const V1 = durable(
      {
        ...options,
        revision: 'v1',
        inputs: { score: Schema.NumberFromString },
      },
      (_, d) => d.input('score', 'only'),
    )
    const V2 = durable(
      {
        ...options,
        revision: 'v2',
        inputs: { score: Schema.Number, note: Schema.String },
      },
      (_, d) => d.input('score', 'only'),
    )
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const old = yield* Client.start(V1, undefined)
        // A sender of the new code only cannot write for the old run.
        const refused = yield* Effect.flip(
          Client.send(V2, old.id, 'score', 'only', 5),
        )
        expect(refused).toMatchObject({
          reason: 'other',
          found: { kind: 'workflow', name: options.name, revision: 'v1' },
        })
        // Holding both, it writes with the run's own schema.
        yield* Client.send([V1, V2], old.id, 'score', 'only', 5)
        yield* serve(served(V1, V2))
        const { run, nodes } = yield* records(old.id)
        expect(run.output).toBe(5)
        expect(nodes.find(({ kind }) => kind === 'input')?.output).toBe('5')
      }),
    )
  })

  it('types a send to several revisions by what they all take', () => {
    const options = {
      name: 'inputs.revised',
      pool: 'default',
      input: Schema.Void,
      output: Schema.Void,
    } as const
    const V1 = durable(
      { ...options, revision: 'v1', inputs: { flag: Schema.Boolean } },
      () => Effect.void,
    )
    const V2 = durable(
      {
        ...options,
        revision: 'v2',
        inputs: { flag: Schema.Boolean, extra: Schema.String },
      },
      () => Effect.void,
    )
    expect(() => Client.send([V1, V2], 'run', 'flag', 'k', true)).not.toThrow()
    const Shape1 = durable(
      {
        ...options,
        revision: 's1',
        inputs: { shape: Schema.Struct({ a: Schema.String }) },
      },
      () => Effect.void,
    )
    const Shape2 = durable(
      {
        ...options,
        revision: 's2',
        inputs: { shape: Schema.Struct({ b: Schema.Number }) },
      },
      () => Effect.void,
    )
    // A value every revision takes: what both need.
    expect(() =>
      Client.send([Shape1, Shape2], 'run', 'shape', 'k', { a: 'x', b: 1 }),
    ).not.toThrow()
    expect(() =>
      // @ts-expect-error what only one of them takes
      Client.send([Shape1, Shape2], 'run', 'shape', 'k', { b: 1 }),
    ).not.toThrow()
    expect(() =>
      // @ts-expect-error a family only one revision takes
      Client.send([V1, V2], 'run', 'extra', 'k', 'x'),
    ).not.toThrow()
  })

  it('types the families a workflow takes and their values', () => {
    expect(() =>
      // @ts-expect-error a family the workflow does not take
      Client.send(Session, 'run', 'question', 'a', { text: 'x' }),
    ).not.toThrow()
    expect(() =>
      // @ts-expect-error a value its family's schema does not describe
      Client.send(Session, 'run', 'answer', 'a', { text: 1 }),
    ).not.toThrow()
    expect(() =>
      durable(
        {
          name: 'inputs.typed',
          revision: 'v1',
          pool: 'default',
          input: Schema.Void,
          output: Schema.Void,
          inputs: { answer: Answer },
        },
        // @ts-expect-error a family the declaration does not name
        (_, d) => d.input('other', 'a'),
      ),
    ).not.toThrow()
  })
})
