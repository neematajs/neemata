import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { DurableDeferred, Workflow, WorkflowEngine } from 'effect/workflow'
import { describe, expect, it } from 'vitest'

import {
  awaitWithin,
  call,
  defineTask,
  defineWorkflow,
  describe as describeDefinition,
  DuplicateName,
  forEach,
  NestedCheckpoint,
  retryStep,
  signal,
  SignalInterrupted,
  sleep,
  start,
  status,
  step,
  StepNotParked,
} from '../src/native-effect/index.ts'
import {
  Codec,
  counter,
  run,
  StampedOnWrite,
  waitFor,
  waitUntil,
} from './support/native-effect.ts'

class Declined extends Schema.TaggedError<Declined>()('Declined', {
  reason: Schema.String,
}) {}

const Approval = DurableDeferred.make('approval', { success: Schema.Boolean })

describe('native Effect workflows on the memory engine', () => {
  it('replays the body around a signal without repeating finished work', async () => {
    const runs = counter()
    const Render = defineTask('memory.render', {
      payload: { invoice: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ invoice }) => invoice,
      pool: 'render',
    })
    const Invoice = defineWorkflow('memory.invoice', {
      payload: { invoice: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ invoice }) => invoice,
    })
    const handlers = Layer.mergeAll(
      Render.toLayer(({ invoice }) =>
        step({
          name: 'render',
          success: Schema.String,
          execute: runs.hit('render').pipe(Effect.as(`receipt://${invoice}`)),
        }),
      ),
      Invoice.toLayer(({ invoice }) =>
        Effect.gen(function* () {
          yield* runs.hit('body')
          yield* step({ name: 'prepare', execute: runs.hit('prepare') })
          const approved = yield* DurableDeferred.await(Approval)
          if (!approved) return 'rejected'
          return yield* call('receipt', Render, { invoice })
        }),
      ),
    )

    await run(
      handlers,
      Effect.gen(function* () {
        const id = yield* start(Invoice, { invoice: '254' })
        yield* waitFor(Invoice, id, 'Suspended')
        expect(runs.read('prepare')).toBe(1)
        expect(runs.read('render')).toBe(0)

        yield* signal(Invoice, id, Approval, Exit.succeed(true))
        const done = yield* waitFor(Invoice, id, 'Succeeded')
        expect(done).toMatchObject({ value: 'receipt://254' })

        // The same business key joins the finished execution.
        expect(yield* start(Invoice, { invoice: '254' })).toBe(id)
        expect(yield* Invoice.execute({ invoice: '254' })).toBe('receipt://254')
        expect(runs.read('body')).toBeGreaterThanOrEqual(2)
        expect(runs.read('prepare')).toBe(1)
        expect(runs.read('render')).toBe(1)
      }),
    )
  })

  it('gives a called task one execution per parent and step', async () => {
    const runs = counter()
    const Embed = defineTask('memory.embed', {
      payload: { text: Schema.String },
      success: Schema.Number,
      idempotencyKey: ({ text }) => text,
    })
    const Index = defineWorkflow('memory.index', {
      payload: { doc: Schema.String },
      success: Schema.Number,
      idempotencyKey: ({ doc }) => doc,
    })
    const handlers = Layer.mergeAll(
      Embed.toLayer(() =>
        step({
          name: 'embed',
          success: Schema.Number,
          execute: runs.hit('embed').pipe(Effect.as(1)),
        }),
      ),
      Index.toLayer(() =>
        Effect.gen(function* () {
          const title = yield* call('title', Embed, { text: 'same' })
          const body = yield* call('body', Embed, { text: 'same' })
          return title + body
        }),
      ),
    )

    await run(
      handlers,
      Effect.gen(function* () {
        expect(yield* Index.execute({ doc: 'a' })).toBe(2)
        expect(yield* Index.execute({ doc: 'b' })).toBe(2)
        // Two parents, two steps each, identical payloads: four executions.
        expect(runs.read('embed')).toBe(4)

        // Started directly, the business key deduplicates.
        yield* Embed.execute({ text: 'same' })
        yield* Embed.execute({ text: 'same' })
        expect(runs.read('embed')).toBe(5)
      }),
    )
  })

  it('rejects a checkpoint name reused in one pass', async () => {
    const runs = counter()
    const Loop = defineWorkflow('memory.loop', {
      payload: { items: Schema.Array(Schema.String) },
      idempotencyKey: ({ items }) => items.join(','),
    })
    const handlers = Loop.toLayer(({ items }) =>
      Effect.forEach(items, () =>
        step({ name: 'send', execute: runs.hit('send') }),
      ),
    )

    await run(
      handlers,
      Effect.gen(function* () {
        const id = yield* start(Loop, { items: ['a', 'b'] })
        const failed = yield* waitFor(Loop, id, 'Failed')
        const defect = Cause.squash(failed.cause)
        expect(defect).toBeInstanceOf(DuplicateName)
        expect(runs.read('send')).toBe(1)
      }),
    )
  })

  // Sequentially the waiting item is reached first, so nothing after it may
  // start: an Exit captured from a suspension would let the loop run on.
  it.each([{ concurrency: 'unbounded' }, { concurrency: 1 }] as const)(
    'settles every item of a fan-out with concurrency $concurrency',
    async ({ concurrency }) => {
      const runs = counter()
      const Gate = DurableDeferred.make('gate')
      const Fanout = defineWorkflow(`memory.fanout.${concurrency}`, {
        payload: { id: Schema.String },
        success: Schema.Array(Schema.String),
        idempotencyKey: ({ id }) => id,
      })
      const handlers = Fanout.toLayer(() =>
        Effect.gen(function* () {
          const exits = yield* forEach(
            'send',
            ['slow', 'ok', 'bad'],
            { key: (item) => item, concurrency },
            (item, name) =>
              Effect.gen(function* () {
                if (item === 'slow') yield* DurableDeferred.await(Gate)
                yield* runs.hit(item)
                return yield* step({
                  name,
                  success: Schema.String,
                  error: Declined,
                  execute:
                    item === 'bad'
                      ? Effect.fail(new Declined({ reason: item }))
                      : Effect.succeed(item),
                })
              }),
          )
          return exits.map((exit) =>
            Exit.isSuccess(exit) ? exit.value : 'failed',
          )
        }),
      )

      await run(
        handlers,
        Effect.gen(function* () {
          const id = yield* start(Fanout, { id: '1' })
          // One failure does not finish the workflow while a sibling waits.
          yield* waitFor(Fanout, id, 'Suspended')
          if (concurrency === 1) expect(runs.read('bad')).toBe(0)
          expect(runs.read('slow')).toBe(0)

          yield* signal(Fanout, id, Gate, Exit.void)
          const done = yield* waitFor(Fanout, id, 'Succeeded')
          expect(done.value).toEqual(['slow', 'ok', 'failed'])
        }),
      )
    },
  )

  it('retries a failing step with backoff and keeps attempts across replay', async () => {
    const runs = counter()
    const Charge = defineWorkflow('memory.charge', {
      payload: { order: Schema.String },
      success: Schema.String,
      error: Declined,
      idempotencyKey: ({ order }) => order,
    })
    const handlers = Charge.toLayer(() =>
      Effect.gen(function* () {
        const receipt = yield* step({
          name: 'charge',
          success: Schema.String,
          error: Declined,
          retry: { times: 2, backoff: () => '5 millis' },
          execute: runs
            .hit('charge')
            .pipe(
              Effect.flatMap((attempt) =>
                attempt < 3
                  ? Effect.fail(new Declined({ reason: `attempt ${attempt}` }))
                  : Effect.succeed('paid'),
              ),
            ),
        })
        // Replaying past the retried step must not run it a fourth time.
        yield* DurableDeferred.await(Approval)
        return receipt
      }),
    )

    await run(
      handlers,
      Effect.gen(function* () {
        const id = yield* start(Charge, { order: '1' })
        // Each backoff suspends the workflow too, so wait on the attempts.
        yield* waitUntil(() => runs.read('charge') === 3)
        yield* waitFor(Charge, id, 'Suspended')

        yield* signal(Charge, id, Approval, Exit.succeed(true))
        const done = yield* waitFor(Charge, id, 'Succeeded')
        expect(done.value).toBe('paid')
        expect(runs.read('charge')).toBe(3)
      }),
    )
  })

  it.each([
    // Every failure is retryable, so only the budget ends the attempts.
    { title: 'the retry budget is spent', fatalAt: 99, attempts: 3 },
    // `while` rejects the second failure with most of the budget left.
    { title: '`while` rejects the failure', fatalAt: 2, attempts: 2 },
  ])(
    'fails with the typed error once $title',
    async ({ fatalAt, attempts }) => {
      const runs = counter()
      const Charge = defineWorkflow(`memory.charge.failed.${fatalAt}`, {
        payload: { order: Schema.String },
        error: Declined,
        idempotencyKey: ({ order }) => order,
      })
      const handlers = Charge.toLayer(() =>
        step({
          name: 'charge',
          error: Declined,
          retry: { times: 2, while: ({ reason }) => reason !== 'fraud' },
          execute: runs.hit('charge').pipe(
            Effect.flatMap((attempt) => {
              const reason = attempt === fatalAt ? 'fraud' : 'busy'
              return Effect.fail(new Declined({ reason }))
            }),
          ),
        }),
      )

      await run(
        handlers,
        Effect.gen(function* () {
          const id = yield* start(Charge, { order: '1' })
          const failed = yield* waitFor(Charge, id, 'Failed')
          expect(Cause.squash(failed.cause)).toBeInstanceOf(Declined)
          expect(runs.read('charge')).toBe(attempts)
        }),
      )
    },
  )

  it('parks an exhausted step until an operator grants a new budget', async () => {
    const runs = counter()
    const Ship = defineWorkflow('memory.ship', {
      payload: { order: Schema.String },
      success: Schema.String,
      error: Declined,
      idempotencyKey: ({ order }) => order,
    })
    const handlers = Ship.toLayer(() =>
      Effect.gen(function* () {
        yield* step({ name: 'reserve', execute: runs.hit('reserve') })
        return yield* step({
          name: 'ship',
          success: Schema.String,
          error: Declined,
          retry: { times: 1 },
          park: true,
          execute: runs
            .hit('ship')
            .pipe(
              Effect.flatMap((attempt) =>
                attempt < 4
                  ? Effect.fail(new Declined({ reason: 'carrier down' }))
                  : Effect.succeed('shipped'),
              ),
            ),
        })
      }),
    )

    await run(
      handlers,
      Effect.gen(function* () {
        const id = yield* start(Ship, { order: '1' })
        yield* waitFor(Ship, id, 'Suspended')
        expect(runs.read('ship')).toBe(2)

        const early = yield* Effect.flip(retryStep(Ship, id, 'reserve'))
        expect(early).toBeInstanceOf(StepNotParked)

        expect(yield* retryStep(Ship, id, 'ship')).toBe(1)
        // The second budget is spent too, so the step parks again.
        yield* waitUntil(() => runs.read('ship') === 4)
        const done = yield* waitFor(Ship, id, 'Succeeded')
        expect(done.value).toBe('shipped')
        expect(runs.read('reserve')).toBe(1)
      }),
    )
  })

  it('records which side of a deadline won', async () => {
    const Archive = DurableDeferred.make('archive')
    const Review = defineWorkflow('memory.review', {
      payload: { doc: Schema.String, millis: Schema.Number },
      success: Schema.String,
      idempotencyKey: ({ doc }) => doc,
    })
    const handlers = Review.toLayer(({ millis }) =>
      Effect.gen(function* () {
        const answer = yield* awaitWithin('review', Approval, millis)
        // A later wait forces a replay after the race is decided.
        yield* DurableDeferred.await(Archive)
        return Option.match(answer, {
          onNone: () => 'expired',
          onSome: (approved) => (approved ? 'approved' : 'rejected'),
        })
      }),
    )

    await run(
      handlers,
      Effect.gen(function* () {
        const late = yield* start(Review, { doc: 'late', millis: 20 })
        yield* Effect.sleep('200 millis')
        // The deadline already won; a late approval must not rewrite it.
        yield* signal(Review, late, Approval, Exit.succeed(true))
        yield* signal(Review, late, Archive, Exit.void)
        expect(yield* waitFor(Review, late, 'Succeeded')).toMatchObject({
          value: 'expired',
        })

        // A deadline far beyond the test leaves only the signal to win.
        const early = yield* start(Review, { doc: 'early', millis: 600_000 })
        yield* waitFor(Review, early, 'Suspended')
        yield* signal(Review, early, Approval, Exit.succeed(true))
        yield* signal(Review, early, Archive, Exit.void)
        expect(yield* waitFor(Review, early, 'Succeeded')).toMatchObject({
          value: 'approved',
        })
      }),
    )
  })

  it('counts a failed signal as an answer only before the deadline', async () => {
    const Verdict = DurableDeferred.make('verdict', {
      success: Schema.Boolean,
      error: Declined,
    })
    const Archive = DurableDeferred.make('archive')
    const Appeal = defineWorkflow('memory.appeal', {
      payload: { doc: Schema.String, millis: Schema.Number },
      success: Schema.String,
      error: Declined,
      idempotencyKey: ({ doc }) => doc,
    })
    const handlers = Appeal.toLayer(({ millis }) =>
      Effect.gen(function* () {
        const answer = yield* Effect.result(
          awaitWithin('appeal', Verdict, millis),
        )
        // A later wait forces a replay after the race is decided.
        yield* DurableDeferred.await(Archive)
        const approved = yield* Effect.fromResult(answer)
        return Option.isSome(approved) ? 'answered' : 'expired'
      }),
    )
    const declined = Exit.fail(new Declined({ reason: 'budget' }))

    await run(
      handlers,
      Effect.gen(function* () {
        const early = yield* start(Appeal, { doc: 'early', millis: 150 })
        yield* waitFor(Appeal, early, 'Suspended')
        yield* signal(Appeal, early, Verdict, declined)
        // The losing deadline still fires and replays the body; the failure
        // recorded before it must stand.
        yield* Effect.sleep('400 millis')
        yield* signal(Appeal, early, Archive, Exit.void)
        const failed = yield* waitFor(Appeal, early, 'Failed')
        expect(Cause.squash(failed.cause)).toMatchObject({
          _tag: 'Declined',
          reason: 'budget',
        })

        const late = yield* start(Appeal, { doc: 'late', millis: 20 })
        yield* Effect.sleep('200 millis')
        // The deadline already won; a late failure must not rewrite it.
        yield* signal(Appeal, late, Verdict, declined)
        yield* signal(Appeal, late, Archive, Exit.void)
        expect(yield* waitFor(Appeal, late, 'Succeeded')).toMatchObject({
          value: 'expired',
        })
      }),
    )
  })

  it('keeps a stored failed signal when a zero deadline is evaluated', async () => {
    const Verdict = DurableDeferred.make('verdict', {
      success: Schema.Boolean,
      error: Declined,
    })
    const Ready = DurableDeferred.make('ready')
    const Review = defineWorkflow('memory.ready-verdict', {
      payload: { doc: Schema.String },
      error: Declined,
      idempotencyKey: ({ doc }) => doc,
    })
    const handlers = Review.toLayer(() =>
      Effect.gen(function* () {
        yield* DurableDeferred.await(Ready)
        yield* awaitWithin('review', Verdict, 0)
      }),
    )

    await run(
      handlers,
      Effect.gen(function* () {
        const id = yield* start(Review, { doc: 'budget' })
        yield* waitFor(Review, id, 'Suspended')
        // Both outcomes are available when the wait runs. A stored signal
        // takes precedence, including when its outcome is a typed failure.
        yield* signal(
          Review,
          id,
          Verdict,
          Exit.fail(new Declined({ reason: 'budget' })),
        )
        yield* signal(Review, id, Ready, Exit.void)
        const failed = yield* waitFor(Review, id, 'Failed')
        expect(Cause.hasInterrupts(failed.cause)).toBe(false)
        expect(Cause.squash(failed.cause)).toMatchObject({
          _tag: 'Declined',
          reason: 'budget',
        })
      }),
    )
  })

  it('settles a failed signal as one item of a fan-out', async () => {
    function vote(voter: string) {
      return DurableDeferred.make(`vote/${voter}`, {
        success: Schema.Boolean,
        error: Declined,
      })
    }
    const Poll = defineWorkflow('memory.poll', {
      payload: { topic: Schema.String },
      success: Schema.Array(Schema.String),
      idempotencyKey: ({ topic }) => topic,
    })
    const handlers = Poll.toLayer(() =>
      Effect.gen(function* () {
        const votes = yield* forEach(
          'votes',
          ['ann', 'bob'],
          { key: (voter) => voter },
          (voter, name) => awaitWithin(name, vote(voter), 600_000),
        )
        return votes.map((exit) => (Exit.isSuccess(exit) ? 'cast' : 'failed'))
      }),
    )

    await run(
      handlers,
      Effect.gen(function* () {
        const id = yield* start(Poll, { topic: 'budget' })
        yield* waitFor(Poll, id, 'Suspended')
        const declined = Exit.fail(new Declined({ reason: 'abstained' }))
        yield* signal(Poll, id, vote('ann'), declined)
        // The failure is ann's result alone; the fan-out still waits for bob.
        yield* Effect.sleep('100 millis')
        expect((yield* status(Poll, id))._tag).toBe('Suspended')

        yield* signal(Poll, id, vote('bob'), Exit.succeed(true))
        expect(yield* waitFor(Poll, id, 'Succeeded')).toMatchObject({
          value: ['failed', 'cast'],
        })
      }),
    )
  })

  // `DurableDeferred.done` writes an exit as given, where `signal` would have
  // refused or cleaned it: these are the outcomes a workflow can find stored.
  function complete<
    Success extends Schema.Constraint,
    E extends Schema.Constraint,
  >(
    workflow: Workflow.Any,
    executionId: string,
    deferred: DurableDeferred.DurableDeferred<Success, E>,
    exit: Exit.Exit<Success['Type'], E['Type']>,
  ) {
    const token = DurableDeferred.tokenFromExecutionId(deferred, {
      workflow,
      executionId,
    })
    return DurableDeferred.done(deferred, { token, exit })
  }

  it.each([
    { wait: 'awaitWithin', within: true },
    { wait: 'DurableDeferred.await', within: false },
  ])(
    'settles a signal that failed with an interruption attached as one item, read by $wait',
    async ({ wait, within }) => {
      function vote(voter: string) {
        return DurableDeferred.make(`vote/${voter}`, {
          success: Schema.Boolean,
          error: Declined,
        })
      }
      const Poll = defineWorkflow(`memory.poll.mixed.${wait}`, {
        payload: { topic: Schema.String },
        success: Schema.Array(Schema.String),
        idempotencyKey: ({ topic }) => topic,
      })
      const handlers = Poll.toLayer(() =>
        Effect.gen(function* () {
          const votes = yield* forEach(
            'votes',
            ['ann', 'bob'],
            { key: (voter) => voter },
            (voter, name) =>
              within
                ? awaitWithin(name, vote(voter), 600_000)
                : DurableDeferred.await(vote(voter)).pipe(Effect.asSome),
          )
          return votes.map((exit) => {
            if (Exit.isSuccess(exit)) return 'cast'
            if (Cause.hasInterrupts(exit.cause)) return 'interrupted'
            return String(Cause.squash(exit.cause))
          })
        }),
      )
      const declined = Cause.fail(new Declined({ reason: 'abstained' }))
      const mixed = Exit.failCause(Cause.combine(declined, Cause.interrupt()))

      await run(
        handlers,
        Effect.gen(function* () {
          const id = yield* start(Poll, { topic: 'budget' })
          yield* waitFor(Poll, id, 'Suspended')
          yield* complete(Poll, id, vote('ann'), mixed)
          // The interruption is part of ann's stored answer. It does not
          // suspend or fail the fan-out, which still waits for bob.
          yield* Effect.sleep('100 millis')
          expect((yield* status(Poll, id))._tag).toBe('Suspended')

          yield* signal(Poll, id, vote('bob'), Exit.succeed(true))
          const done = yield* waitFor(Poll, id, 'Succeeded')
          expect(done.value).toEqual([
            String(new Declined({ reason: 'abstained' })),
            'cast',
          ])
        }),
      )
    },
  )

  it.each([
    // The interruption is stored while the wait is parked.
    { title: 'while it waits', stored: 'during', millis: 600_000 },
    // It is already stored when the wait starts, with the deadline passed too.
    { title: 'before a zero deadline', stored: 'before', millis: 0 },
  ] as const)(
    'fails a wait whose signal holds only an interruption, stored $title',
    async ({ stored, millis }) => {
      const Ready = DurableDeferred.make('ready')
      const Review = defineWorkflow(`memory.review.interrupted.${stored}`, {
        payload: { doc: Schema.String },
        success: Schema.String,
        idempotencyKey: ({ doc }) => doc,
      })
      const handlers = Review.toLayer(() =>
        Effect.gen(function* () {
          yield* DurableDeferred.await(Ready)
          const answer = yield* awaitWithin('review', Approval, millis)
          return Option.isSome(answer) ? 'answered' : 'expired'
        }),
      )

      await run(
        handlers,
        Effect.gen(function* () {
          const id = yield* start(Review, { doc: 'budget' })
          yield* waitFor(Review, id, 'Suspended')
          if (stored === 'before') {
            yield* complete(Review, id, Approval, Exit.interrupt())
            yield* signal(Review, id, Ready, Exit.void)
          } else {
            yield* signal(Review, id, Ready, Exit.void)
            yield* Effect.sleep('50 millis')
            yield* complete(Review, id, Approval, Exit.interrupt())
          }

          // Not an interruption of the workflow, and not a wait that lasts
          // until the deadline: the wait fails as soon as it reads the signal.
          const failed = yield* waitFor(Review, id, 'Failed')
          expect(Cause.hasInterrupts(failed.cause)).toBe(false)
          expect(Cause.squash(failed.cause)).toMatchObject({
            _tag: 'SignalInterrupted',
            executionId: id,
            signal: 'approval',
          })
        }),
      )
    },
  )

  it('refuses to send a signal that holds only an interruption', async () => {
    const Review = defineWorkflow('memory.review.refused', {
      payload: { doc: Schema.String },
      success: Schema.Boolean,
      idempotencyKey: ({ doc }) => doc,
    })
    const handlers = Review.toLayer(() => DurableDeferred.await(Approval))

    await run(
      handlers,
      Effect.gen(function* () {
        const id = yield* start(Review, { doc: 'budget' })
        yield* waitFor(Review, id, 'Suspended')

        const refused = yield* Effect.flip(
          signal(Review, id, Approval, Exit.interrupt()),
        )
        expect(refused).toBeInstanceOf(SignalInterrupted)
        expect(refused).toMatchObject({ executionId: id, signal: 'approval' })

        // A signal is completed once. The real answer is still accepted, so
        // the refused one was never stored.
        yield* signal(Review, id, Approval, Exit.succeed(true))
        const done = yield* waitFor(Review, id, 'Succeeded')
        expect(done.value).toBe(true)
      }),
    )
  })

  it('suspends a fan-out while a branch inside one of its items still waits', async () => {
    const runs = counter()
    function gate(parcel: string) {
      return DurableDeferred.make(`gate/${parcel}`)
    }
    const Dispatch = defineWorkflow('memory.dispatch', {
      payload: { id: Schema.String },
      success: Schema.Array(Schema.String),
      idempotencyKey: ({ id }) => id,
    })
    const handlers = Dispatch.toLayer(() =>
      Effect.gen(function* () {
        const exits = yield* forEach(
          'ship',
          ['a', 'b'],
          { key: (parcel) => parcel },
          (parcel, name) =>
            // The waiting branch runs on a fiber of its own, so its
            // suspension reaches the item as a cause rather than by
            // interrupting it. It still has to suspend the workflow.
            Effect.all(
              [
                DurableDeferred.await(gate(parcel)),
                step({ name: `${name}/pack`, execute: runs.hit('pack') }),
              ],
              { concurrency: 'unbounded' },
            ),
        )
        yield* runs.hit('after')
        return exits.map((exit) => exit._tag)
      }),
    )

    await run(
      handlers,
      Effect.gen(function* () {
        const id = yield* start(Dispatch, { id: '1' })
        yield* waitFor(Dispatch, id, 'Suspended')

        yield* signal(Dispatch, id, gate('a'), Exit.void)
        yield* waitUntil(() => runs.read('pack') === 1)
        yield* Effect.sleep('100 millis')
        // One item is still waiting: nothing after the fan-out may run.
        expect((yield* status(Dispatch, id))._tag).toBe('Suspended')
        expect(runs.read('after')).toBe(0)

        yield* signal(Dispatch, id, gate('b'), Exit.void)
        const done = yield* waitFor(Dispatch, id, 'Succeeded')
        expect(done.value).toEqual(['Success', 'Success'])
        expect(runs.read('pack')).toBe(2)
      }),
    )
  })

  it('rejects a step inside a step before it can share a later checkpoint', async () => {
    const runs = counter()
    const Nested = defineWorkflow('memory.nested', {
      payload: { id: Schema.String },
      success: Schema.Array(Schema.String),
      idempotencyKey: ({ id }) => id,
    })
    const handlers = Nested.toLayer(() =>
      Effect.gen(function* () {
        const inner = yield* step({
          name: 'outer',
          success: Schema.String,
          execute: step({
            name: 'same',
            success: Schema.String,
            execute: runs.hit('inner').pipe(Effect.as('inner')),
          }),
        })
        // Stored under the same key as the inner step: without the guard
        // this body never runs and the workflow returns the inner result.
        const later = yield* step({
          name: 'same',
          success: Schema.String,
          execute: runs.hit('later').pipe(Effect.as('later')),
        })
        return [inner, later]
      }),
    )

    await run(
      handlers,
      Effect.gen(function* () {
        const id = yield* start(Nested, { id: '1' })
        const failed = yield* waitFor(Nested, id, 'Failed')
        const defect = Cause.squash(failed.cause)
        expect(defect).toBeInstanceOf(NestedCheckpoint)
        expect(defect).toMatchObject({ checkpoint: 'same', step: 'outer' })
        expect(runs.read('inner')).toBe(0)
        expect(runs.read('later')).toBe(0)
      }),
    )
  })

  it('rejects a call inside a step', async () => {
    const runs = counter()
    const Embed = defineTask('memory.nested.embed', {
      payload: { text: Schema.String },
      idempotencyKey: ({ text }) => text,
    })
    const Index = defineWorkflow('memory.nested.index', {
      payload: { doc: Schema.String },
      idempotencyKey: ({ doc }) => doc,
    })
    const handlers = Layer.mergeAll(
      Embed.toLayer(() => runs.hit('embed')),
      Index.toLayer(({ doc }) =>
        step({ name: 'index', execute: call('embed', Embed, { text: doc }) }),
      ),
    )

    await run(
      handlers,
      Effect.gen(function* () {
        const id = yield* start(Index, { doc: 'a' })
        const failed = yield* waitFor(Index, id, 'Failed')
        const defect = Cause.squash(failed.cause)
        expect(defect).toBeInstanceOf(NestedCheckpoint)
        expect(defect).toMatchObject({ checkpoint: 'embed', step: 'index' })
        expect(runs.read('embed')).toBe(0)
      }),
    )
  })

  it('accepts steps in helper functions and in a workflow started from a step', async () => {
    const runs = counter()
    const Audit = defineWorkflow('memory.audit', {
      payload: { order: Schema.String },
      idempotencyKey: ({ order }) => order,
    })
    const Order = defineWorkflow('memory.order', {
      payload: { order: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ order }) => order,
    })
    // Splitting a body into functions nests nothing: these steps still run
    // in the workflow body.
    function reserve(order: string) {
      return Effect.gen(function* () {
        yield* step({ name: 'stock', execute: runs.hit('stock') })
        yield* sleep('settle', 1)
        return yield* step({
          name: 'label',
          success: Schema.String,
          execute: Effect.succeed(`label://${order}`),
        })
      })
    }
    const handlers = Layer.mergeAll(
      Audit.toLayer(() =>
        step({ name: 'record', execute: runs.hit('record') }),
      ),
      Order.toLayer(({ order }) =>
        Effect.gen(function* () {
          const label = yield* reserve(order)
          // The audit is another execution with a body of its own. Its steps
          // are not inside this one, although this step started it.
          const audit = yield* step({
            name: 'audit',
            success: Schema.String,
            execute: start(Audit, { order }),
          })
          return yield* waitFor(Audit, audit, 'Succeeded').pipe(
            Effect.as(label),
            Effect.orDie,
          )
        }),
      ),
    )

    await run(
      handlers,
      Effect.gen(function* () {
        const id = yield* start(Order, { order: '7' })
        const done = yield* waitFor(Order, id, 'Succeeded')
        expect(done.value).toBe('label://7')
        expect(runs.read('stock')).toBe(1)
        expect(runs.read('record')).toBe(1)
      }),
    )
  })

  it.each([
    {
      title: 'result',
      fail: false,
      tag: 'Succeeded',
      stored: 'sealed:receipt',
    },
    { title: 'failure', fail: true, tag: 'Failed', stored: 'sealed:declined' },
  ] as const)(
    'writes a step $title with the service its schema requires',
    async ({ fail, tag, stored }) => {
      const Seal = defineWorkflow(`memory.seal.${tag}`, {
        payload: { id: Schema.String },
        success: Schema.String,
        error: Schema.String,
        idempotencyKey: ({ id }) => id,
      })
      const handlers = Seal.toLayer(() =>
        step({
          name: 'seal',
          success: StampedOnWrite,
          error: StampedOnWrite,
          execute: fail ? Effect.fail('declined') : Effect.succeed('receipt'),
        }),
      )
      const codec = Layer.succeed(Codec, { prefix: 'sealed:' })

      await run(
        handlers.pipe(Layer.provide(codec)),
        Effect.gen(function* () {
          const id = yield* start(Seal, { id: '1' })
          // The step hands back what it stored, so the prefix shows that the
          // schema's writer ran with the service.
          const settled = yield* waitFor(Seal, id, tag)
          const value =
            settled._tag === 'Succeeded'
              ? settled.value
              : Cause.squash(settled.cause)
          expect(value).toBe(stored)
        }),
      )
    },
  )

  it('rejects a name reused inside the arm of a durable race', async () => {
    const runs = counter()
    const Race = defineWorkflow('memory.race', {
      payload: { id: Schema.String },
      idempotencyKey: ({ id }) => id,
    })
    const handlers = Race.toLayer(() =>
      Effect.gen(function* () {
        yield* step({ name: 'notify', execute: runs.hit('notify') })
        // The arm runs under a copy of the workflow instance but shares its
        // checkpoints, so the second `notify` would return the first result.
        yield* DurableDeferred.raceAll({
          name: 'race',
          success: Schema.Void,
          error: Schema.Never,
          effects: [step({ name: 'notify', execute: runs.hit('notify') })],
        })
      }),
    )

    await run(
      handlers,
      Effect.gen(function* () {
        const id = yield* start(Race, { id: '1' })
        const failed = yield* waitFor(Race, id, 'Failed')
        expect(Cause.squash(failed.cause)).toBeInstanceOf(DuplicateName)
        expect(runs.read('notify')).toBe(1)
      }),
    )
  })

  it('runs compensation when a waiting workflow is interrupted', async () => {
    const runs = counter()
    const Booking = defineWorkflow('memory.booking', {
      payload: { trip: Schema.String },
      idempotencyKey: ({ trip }) => trip,
    })
    const handlers = Booking.toLayer(() =>
      Effect.gen(function* () {
        yield* step({ name: 'hold', execute: runs.hit('hold') }).pipe(
          Workflow.withCompensation(() => runs.hit('release')),
        )
        yield* DurableDeferred.await(Approval)
      }),
    )

    await run(
      handlers,
      Effect.gen(function* () {
        const id = yield* start(Booking, { trip: '1' })
        yield* waitFor(Booking, id, 'Suspended')

        yield* Booking.interrupt(id)
        yield* waitFor(Booking, id, 'Interrupted')
        expect(runs.read('hold')).toBe(1)
        // Each replay registers the compensation again, so it can run more
        // than once and has to be idempotent.
        expect(runs.read('release')).toBeGreaterThanOrEqual(1)

        // An interrupted execution is final: the key does not start a new one.
        expect(yield* start(Booking, { trip: '1' })).toBe(id)
        expect((yield* status(Booking, id))._tag).toBe('Interrupted')
      }),
    )
  })

  it('gives handlers layer services that live as long as the runtime', async () => {
    const log: string[] = []
    class Ledger extends Context.Service<
      Ledger,
      { readonly append: (entry: string) => Effect.Effect<void> }
    >()('test/Ledger') {}
    const LedgerLive = Layer.effect(Ledger)(
      Effect.acquireRelease(
        Effect.sync(() => {
          log.push('open')
          return { append: (entry) => Effect.sync(() => void log.push(entry)) }
        }),
        () => Effect.sync(() => void log.push('close')),
      ),
    )
    const Post = defineWorkflow('memory.post', {
      payload: { entry: Schema.String },
      idempotencyKey: ({ entry }) => entry,
    })
    const handlers = Post.toLayer(({ entry }) =>
      step({
        name: 'append',
        execute: Effect.gen(function* () {
          const ledger = yield* Ledger
          yield* ledger.append(entry)
        }),
      }),
    )
    const runtime = ManagedRuntime.make(
      handlers.pipe(
        Layer.provideMerge(WorkflowEngine.layerMemory),
        Layer.provide(LedgerLive),
      ),
    )

    await runtime.runPromise(Post.execute({ entry: 'a' }))
    await runtime.runPromise(Post.execute({ entry: 'b' }))
    expect(log).toEqual(['open', 'a', 'b'])

    await runtime.dispose()
    expect(log).toEqual(['open', 'a', 'b', 'close'])
  })

  it('describes a definition without its call key', () => {
    const Render = defineTask('memory.described', {
      payload: { invoice: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ invoice }) => invoice,
      pool: 'render',
    })

    const description = describeDefinition(Render)
    expect(description).toMatchObject({
      name: 'memory.described',
      kind: 'task',
      pool: 'render',
    })
    expect(description.payload.schema).toMatchObject({
      properties: { invoice: { type: 'string' } },
      required: ['invoice'],
    })
    expect(JSON.stringify(description.payload)).not.toContain('nmtjs')
  })
})
