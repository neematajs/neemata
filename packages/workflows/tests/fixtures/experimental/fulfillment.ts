import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { task, workflow } from '../../../src/experimental/index.ts'

/** The carrier API; the worker supplies it. */
export class Carriers extends Context.Service<
  Carriers,
  { readonly book: (order: string, sku: string) => Effect.Effect<string> }
>()('fulfillment/Carriers') {}

const Line = Schema.Struct({
  sku: Schema.String,
  quantity: Schema.NumberFromString,
})
const Lines = Schema.Array(Line)
const Order = Schema.Struct({
  id: Schema.String,
  gift: Schema.Boolean,
  lines: Lines,
})
const Risk = Schema.Literals(['low', 'high'])
const Reserved = Schema.Struct({ sku: Schema.String, bin: Schema.String })
const Parcel = Schema.Struct({
  order: Schema.String,
  sku: Schema.String,
  bin: Schema.String,
})
const Label = Schema.Struct({ sku: Schema.String, tracking: Schema.String })
const Summary = Schema.Struct({
  order: Schema.String,
  units: Schema.Number,
  risk: Risk,
  tracking: Schema.Array(Schema.String),
  note: Schema.String,
})

export const Screen = task({
  name: 'fulfillment.screen',
  pool: 'risk',
  input: Schema.String,
  output: Risk,
  handler: (order) => Effect.succeed(order.startsWith('x') ? 'high' : 'low'),
})

export const Reserve = task({
  name: 'fulfillment.reserve',
  pool: 'warehouse',
  input: Line,
  output: Reserved,
  handler: ({ sku, quantity }) =>
    Effect.succeed({ sku, bin: `bin-${quantity}` }),
})

/** One parcel. Its activity runs on the `shipping` pool and needs Carriers. */
export const Ship = workflow(
  { name: 'fulfillment.ship', pool: 'shipping', input: Parcel, output: Label },
  function* (w) {
    return yield* w.activity('label', {
      input: Parcel,
      output: Label,
      from: w.input,
      retry: { attempts: 3 },
      timeout: '30s',
      handler: ({ order, sku }) =>
        Effect.gen(function* () {
          const carriers = yield* Carriers
          const tracking = yield* carriers.book(order, sku)
          return { sku, tracking }
        }),
    })
  },
)

export const Fulfillment = workflow(
  {
    name: 'fulfillment',
    pool: 'fulfillment',
    input: Order,
    output: Summary,
  },
  function* (w) {
    // Both members run; neither can read the other.
    const checks = yield* w.parallel('checks', {
      members: (p) => ({
        units: p.activity({
          input: Lines,
          output: Schema.Number,
          from: (read) => read(w.input).lines,
          handler: (lines) =>
            Effect.succeed(lines.reduce((sum, line) => sum + line.quantity, 0)),
        }),
        risk: p.task(Screen, { input: (read) => read(w.input).id }),
      }),
    })

    // One Reserve run per line, two at a time.
    const reserved = yield* w.mapTask('reserve', Reserve, {
      item: Line,
      items: (read) => read(w.input).lines,
      input: (_read, line) => line,
      concurrency: 2,
    })

    // One Ship child workflow per reserved line.
    const shipped = yield* w.mapWorkflow('ship', Ship, {
      item: Reserved,
      items: (read) => read(reserved).items.map(({ output }) => output),
      input: (read, { sku, bin }) => ({ order: read(w.input).id, sku, bin }),
    })

    const note = yield* w.branch('wrap', {
      select: (read) => (read(w.input).gift ? 'gift' : 'plain'),
      cases: (p) => ({
        gift: p.activity({
          input: Schema.String,
          output: Schema.String,
          from: (read) => read(w.input).id,
          handler: (order) => Effect.succeed(`gift receipt for ${order}`),
        }),
        plain: p.activity({
          input: Schema.Number,
          output: Schema.String,
          from: (read) => read(checks).units,
          handler: (units) => Effect.succeed(`${units} units`),
        }),
      }),
    })

    return (read) => ({
      order: read(w.input).id,
      units: read(checks).units,
      risk: read(checks).risk,
      tracking: read(shipped).items.map(({ output }) => output.tracking),
      note: read(note),
    })
  },
)
