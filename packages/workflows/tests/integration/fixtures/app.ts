import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { threadId } from 'node:worker_threads'

import { schedule, task, workflow } from '@nmtjs/workflows'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

/**
 * What the worker processes of the integration tests serve. Everything a
 * scenario needs to steer is in a run's input or in the environment, so one
 * build of these declarations serves the test process and every process it
 * spawns.
 */

const eventsFile = process.env.WORKFLOWS_EVENTS
const holdDir = process.env.WORKFLOWS_HOLD_DIR

export type Recorded = {
  readonly event: string
  readonly pid: number
  readonly thread: number
  readonly [field: string]: unknown
}

/** One line per event, appended by whichever process the handler ran in. */
export const record = (event: string, fields: Record<string, unknown> = {}) =>
  Effect.sync(() => {
    if (!eventsFile) return
    const line = { event, pid: process.pid, thread: threadId, ...fields }
    appendFileSync(eventsFile, `${JSON.stringify(line)}\n`)
  })

/** Where the first delivery to reach `name` left its mark, if it has. */
export const holdMarker = (dir: string, name: string) => join(dir, name)

/** Whether this delivery is the first to reach `name`; it is marked if so. */
function first(name: string) {
  if (!holdDir) return false
  const marker = holdMarker(holdDir, name)
  if (existsSync(marker)) return false
  writeFileSync(marker, String(process.pid))
  return true
}

/**
 * The first delivery to reach `name` never returns: its process is killed,
 * stopped or frozen under it. A later delivery passes. It yields to
 * interruption, and says when it was interrupted.
 */
const gate = (name: string) =>
  Effect.suspend(() =>
    first(name)
      ? Effect.onInterrupt(Effect.never, () => record('interrupted', { name }))
      : Effect.void,
  )

/**
 * The same for code the coordinator runs, which cannot wait: the first pass
 * to reach `name` blocks its thread for good, in the middle of the pass.
 */
function stall(name: string) {
  if (first(name)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}

/**
 * The first delivery to reach `name` never ends, and does not yield when it
 * is told to stop: only the end of its thread or process ends it.
 */
const stubborn = (name: string) =>
  Effect.suspend(() =>
    first(name)
      ? Effect.andThen(
          record('held', { name }),
          Effect.uninterruptible(Effect.never),
        )
      : Effect.void,
  )

/** Two tasks of one pool; the first attempt of each never ends. */
export const recovery = ['timed', 'sibling'].map((name) =>
  task({
    name: `it.recovery.${name}`,
    pool: 'recovery',
    input: Schema.Number,
    output: Schema.Number,
    retry: { attempts: 3 },
    // The timed one is told to stop by its time limit, and does not.
    ...(name === 'timed' ? { timeout: '300ms' as const } : {}),
    handler: (input: number) =>
      Effect.gen(function* () {
        yield* stubborn(name)
        yield* record('recovered', { name })
        return input + 1
      }),
  }),
)

const Hold = Schema.Literals(['none', 'activity', 'task', 'pass'])

const OrderInput = Schema.Struct({
  id: Schema.String,
  items: Schema.Array(Schema.String),
  express: Schema.Boolean,
  /** Where the first delivery of the run stops for good. */
  hold: Hold,
})
export type OrderInput = typeof OrderInput.Type

const StampInput = Schema.Struct({ key: Schema.String, hold: Schema.Boolean })

/** A task on a pool of its own; every step that is a task runs it. */
export const Stamp = task({
  name: 'it.stamp',
  pool: 'stamps',
  input: StampInput,
  output: Schema.String,
  handler: ({ key, hold }, attempt) =>
    Effect.gen(function* () {
      if (hold) yield* gate(`${key}.task`)
      yield* record('ran', { step: key, work: attempt.idempotencyKey })
      return `stamped:${key}`
    }),
})

const PackInput = Schema.Struct({ order: Schema.String, item: Schema.String })

/** A child workflow of one activity. */
export const Pack = workflow(
  { name: 'it.pack', pool: 'orders', input: PackInput, output: Schema.String },
  function* (w) {
    return yield* w.activity('box', {
      input: PackInput,
      output: Schema.String,
      from: w.input,
      handler: ({ order, item }, attempt) =>
        Effect.as(
          record('ran', {
            step: `${order}:box:${item}`,
            work: attempt.idempotencyKey,
          }),
          `boxed:${item}`,
        ),
    })
  },
)

const OrderOutput = Schema.Struct({
  id: Schema.String,
  prepared: Schema.Number,
  first: Schema.String,
  lines: Schema.Array(Schema.String),
  pack: Schema.String,
  parcels: Schema.Array(Schema.String),
  route: Schema.String,
  label: Schema.String,
  receipt: Schema.String,
})

/** One step of every kind the engine has. */
export const Order = workflow(
  { name: 'it.order', pool: 'orders', input: OrderInput, output: OrderOutput },
  function* (w) {
    const prepared = yield* w.activity('prepare', {
      input: OrderInput,
      output: Schema.Number,
      from: w.input,
      handler: ({ id, items, hold }, attempt) =>
        Effect.gen(function* () {
          if (hold === 'activity') yield* gate(`${id}.activity`)
          yield* record('ran', {
            step: `${id}:prepare`,
            work: attempt.idempotencyKey,
          })
          return items.length
        }),
    })
    const stamped = yield* w.task('first', Stamp, {
      input: Effect.map(w.input, ({ id, hold }) => ({
        key: `${id}:first`,
        hold: hold === 'task',
      })),
    })
    const lines = yield* w.mapTask('lines', Stamp, {
      item: Schema.String,
      items: Effect.map(w.input, ({ items }) => items),
      input: (item) =>
        Effect.map(w.input, ({ id }) => ({
          key: `${id}:line:${item}`,
          hold: false,
        })),
      concurrency: 2,
    })
    const pack = yield* w.workflow('pack', Pack, {
      input: Effect.map(w.input, ({ id }) => ({ order: id, item: 'all' })),
    })
    const parcels = yield* w.mapWorkflow('parcels', Pack, {
      item: Schema.String,
      items: Effect.map(w.input, ({ items }) => items),
      input: (item) => Effect.map(w.input, ({ id }) => ({ order: id, item })),
    })
    const route = yield* w.branch('route', {
      select: Effect.map(w.input, ({ id, express, hold }) => {
        if (hold === 'pass') stall(`${id}.pass`)
        return express ? 'express' : 'standard'
      }),
      cases: (p) => ({
        express: p.task(Stamp, {
          input: Effect.map(w.input, ({ id }) => ({
            key: `${id}:express`,
            hold: false,
          })),
        }),
        standard: p.activity({
          input: Schema.String,
          output: Schema.String,
          from: Effect.map(w.input, ({ id }) => id),
          handler: (id, attempt) =>
            Effect.as(
              record('ran', {
                step: `${id}:standard`,
                work: attempt.idempotencyKey,
              }),
              `standard:${id}`,
            ),
        }),
      }),
    })
    const wrap = yield* w.parallel('wrap', {
      members: (p) => ({
        label: p.activity({
          input: Schema.String,
          output: Schema.String,
          from: Effect.map(w.input, ({ id }) => id),
          handler: (id, attempt) =>
            Effect.as(
              record('ran', {
                step: `${id}:label`,
                work: attempt.idempotencyKey,
              }),
              `label:${id}`,
            ),
        }),
        receipt: p.task(Stamp, {
          input: Effect.map(w.input, ({ id }) => ({
            key: `${id}:receipt`,
            hold: false,
          })),
        }),
      }),
    })

    return Effect.gen(function* () {
      const { label, receipt } = yield* wrap
      return {
        id: (yield* w.input).id,
        prepared: yield* prepared,
        first: yield* stamped,
        lines: (yield* lines).items.map(({ output }) => output),
        pack: yield* pack,
        parcels: (yield* parcels).items.map(({ output }) => output),
        route: yield* route,
        label,
        receipt,
      }
    })
  },
)

/** What a run of `Order` ends with. */
export const orderOutput = ({ id, items, express }: OrderInput) => ({
  id,
  prepared: items.length,
  first: `stamped:${id}:first`,
  lines: items.map((item) => `stamped:${id}:line:${item}`),
  pack: 'boxed:all',
  parcels: items.map((item) => `boxed:${item}`),
  route: express ? `stamped:${id}:express` : `standard:${id}`,
  label: `label:${id}`,
  receipt: `stamped:${id}:receipt`,
})

/** The steps whose handlers a run of `Order` runs, as they record them. */
export const orderSteps = ({ id, items, express }: OrderInput) =>
  [
    `${id}:prepare`,
    `${id}:first`,
    ...items.map((item) => `${id}:line:${item}`),
    `${id}:box:all`,
    ...items.map((item) => `${id}:box:${item}`),
    express ? `${id}:express` : `${id}:standard`,
    `${id}:label`,
    `${id}:receipt`,
  ].toSorted()

/** What a schedule starts: one activity that records its run. */
export const Tick = workflow(
  {
    name: 'it.tick',
    pool: 'orders',
    input: Schema.String,
    output: Schema.String,
  },
  function* (w) {
    return yield* w.activity('tick', {
      input: Schema.String,
      output: Schema.String,
      from: w.input,
      handler: (text, attempt) =>
        Effect.as(record('ticked', { runId: attempt.runId }), text),
    })
  },
)

export const EverySecond = schedule({
  name: 'it.every-second',
  runnable: Tick,
  input: 'tick',
  every: '1s',
  immediately: true,
})

/**
 * The worker a handler runs in, as whoever hosts the worker names it, and
 * what a host in the test's own process wants to be told of each step.
 */
export class Host extends Context.Service<
  Host,
  {
    readonly pool: string
    readonly saw?: (step: {
      readonly step: string
      readonly revision: string
    }) => void
  }
>()('integration/Host') {}

const text = Schema.String

/**
 * One revision of a family of a workflow, a task and a child workflow, on a
 * pool of its own: a revision is then also a route to other workers. Every
 * step stamps its input with the revision whose code ran it.
 *
 * `reshaped` builds the workflow with another graph under the same revision,
 * which is what a deployment that edits a revision in place does.
 */
export function generation(
  revision: string,
  pool: string,
  { reshaped = false }: { readonly reshaped?: boolean } = {},
) {
  const stamp = (step: string, input: string) =>
    Effect.gen(function* () {
      const host = yield* Host
      yield* record('stamped', { step, revision, servedBy: host.pool, input })
      host.saw?.({ step, revision })
      return `${input}|${step}@${revision}`
    })

  const Work = task({
    name: 'it.rev.task',
    revision,
    pool,
    input: text,
    output: text,
    handler: (input) => stamp('task', input),
  })
  const Child = workflow(
    { name: 'it.rev.child', revision, pool, input: text, output: text },
    function* (w) {
      return yield* w.activity('step', {
        input: text,
        output: text,
        from: w.input,
        handler: (input) => stamp('child', input),
      })
    },
  )
  const Parent = workflow(
    {
      name: 'it.rev.parent',
      revision,
      pool,
      input: text,
      output: Schema.Array(text),
    },
    function* (w) {
      const first = yield* w.activity(reshaped ? 'renamed' : 'first', {
        input: text,
        output: text,
        from: w.input,
        handler: (input) =>
          Effect.gen(function* () {
            if (input.startsWith('hang')) yield* gate(`${input}.${revision}`)
            return yield* stamp('first', input)
          }),
      })
      const work = yield* w.task('work', Work, { input: w.input })
      const sub = yield* w.workflow('sub', Child, { input: w.input })
      return Effect.all([first, work, sub])
    },
  )

  return {
    revision,
    pool,
    Parent,
    Child,
    Work,
    workflows: [Parent, Child],
    tasks: [Work],
  }
}

export const revisionOutput = (input: string, revision: string) =>
  ['first', 'task', 'child'].map((step) => `${input}|${step}@${revision}`)

/** The pool each revision of the family runs on. */
export const revisionPools: Record<string, string> = { v1: 'io', v2: 'heavy' }
