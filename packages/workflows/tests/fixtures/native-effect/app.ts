import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { DurableDeferred } from 'effect/workflow'

import {
  awaitWithin,
  call,
  defineTask,
  defineWorkflow,
  sleep,
  step,
} from '../../../src/native-effect/index.ts'

export class CarrierDown extends Schema.TaggedError<CarrierDown>()(
  'CarrierDown',
  {},
) {}

export class Declined extends Schema.TaggedError<Declined>()('Declined', {
  reason: Schema.String,
}) {}

export const Approval = DurableDeferred.make('approval', {
  success: Schema.Boolean,
})

export const Verdict = DurableDeferred.make('verdict', {
  success: Schema.Boolean,
  error: Declined,
})

export const Archive = DurableDeferred.make('archive')

export const Render = defineTask('native.render', {
  payload: { invoice: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ invoice }) => invoice,
  pool: 'render',
})

export const Invoice = defineWorkflow('native.invoice', {
  payload: { invoice: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ invoice }) => invoice,
})

export const Crash = defineWorkflow('native.crash', {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
})

export const Nap = defineWorkflow('native.nap', {
  payload: { id: Schema.String, millis: Schema.Number },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
})

export const Review = defineWorkflow('native.review', {
  payload: { doc: Schema.String, millis: Schema.Number },
  success: Schema.String,
  idempotencyKey: ({ doc }) => doc,
})

export const Appeal = defineWorkflow('native.appeal', {
  payload: { doc: Schema.String, millis: Schema.Number },
  success: Schema.String,
  error: Declined,
  idempotencyKey: ({ doc }) => doc,
})

// Placed outside the default pool, with payload fields named like the
// engine's own message fields.
export const Proof = defineWorkflow('native.proof', {
  payload: { name: Schema.Number, exit: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ name }) => String(name),
  pool: 'render',
})

export const Ship = defineWorkflow('native.ship', {
  payload: { order: Schema.String },
  success: Schema.String,
  error: CarrierDown,
  idempotencyKey: ({ order }) => order,
})

export const definitions = [
  Render,
  Invoice,
  Crash,
  Nap,
  Review,
  Appeal,
  Proof,
  Ship,
]

export type Probe = {
  /** Records that a piece of handler code ran. */
  readonly record: (event: string) => Effect.Effect<void>
  /** Resolves once the test lets the blocked step finish. */
  readonly released: Effect.Effect<void>
  /** Whether the test has released yet, without waiting for it. */
  readonly isReleased: Effect.Effect<boolean>
}

/** Handlers per pool, so a runner registers only what its pools execute. */
export function handlers(probe: Probe) {
  const { record, released, isReleased } = probe

  const render = Render.toLayer(({ invoice }) =>
    step({
      name: 'render',
      success: Schema.String,
      execute: record(`render:${invoice}`).pipe(
        Effect.as(`receipt://${invoice}`),
      ),
    }),
  )

  const invoice = Invoice.toLayer(({ invoice }) =>
    Effect.gen(function* () {
      yield* step({ name: 'prepare', execute: record(`prepare:${invoice}`) })
      const approved = yield* DurableDeferred.await(Approval)
      if (!approved) return 'rejected'
      return yield* call('receipt', Render, { invoice })
    }),
  )

  const crash = Crash.toLayer(({ id }) =>
    Effect.gen(function* () {
      yield* step({ name: 'first', execute: record(`first:${id}`) })
      yield* step({
        name: 'hang',
        execute: record(`hang:start:${id}`).pipe(
          Effect.andThen(released),
          Effect.andThen(record(`hang:done:${id}`)),
        ),
      })
      yield* step({ name: 'last', execute: record(`last:${id}`) })
      return 'recovered'
    }),
  )

  const nap = Nap.toLayer(({ id, millis }) =>
    Effect.gen(function* () {
      yield* step({ name: 'before', execute: record(`before:${id}`) })
      yield* sleep('nap', millis)
      yield* step({ name: 'after', execute: record(`after:${id}`) })
      return 'rested'
    }),
  )

  const review = Review.toLayer(({ millis }) =>
    Effect.gen(function* () {
      const answer = yield* awaitWithin('review', Approval, millis)
      return Option.match(answer, {
        onNone: () => 'expired',
        onSome: (approved) => (approved ? 'approved' : 'rejected'),
      })
    }),
  )

  const appeal = Appeal.toLayer(({ millis }) =>
    Effect.gen(function* () {
      const answer = yield* Effect.result(
        awaitWithin('appeal', Verdict, millis),
      )
      // A later wait keeps the run open, so the decision above is replayed.
      yield* DurableDeferred.await(Archive)
      const approved = yield* Effect.fromResult(answer)
      return Option.isSome(approved) ? 'answered' : 'expired'
    }),
  )

  const ship = Ship.toLayer(({ order }) =>
    Effect.gen(function* () {
      yield* step({ name: 'reserve', execute: record(`reserve:${order}`) })
      return yield* step({
        name: 'ship',
        success: Schema.String,
        error: CarrierDown,
        retry: { times: 1, backoff: () => '20 millis' },
        park: true,
        execute: record(`ship:${order}`).pipe(
          Effect.andThen(isReleased),
          Effect.flatMap((up) =>
            up ? Effect.succeed('shipped') : Effect.fail(new CarrierDown()),
          ),
        ),
      })
    }),
  )

  const proof = Proof.toLayer(({ exit }) =>
    DurableDeferred.await(Approval).pipe(
      Effect.map((approved) => (approved ? exit : 'rejected')),
    ),
  )

  return {
    default: Layer.mergeAll(invoice, crash, nap, review, appeal, ship),
    render: Layer.mergeAll(render, proof),
  }
}
