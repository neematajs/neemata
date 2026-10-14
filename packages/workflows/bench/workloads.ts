import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { task, workflow } from '../src/index.ts'

/** What every step of every workload reads and writes. */
export const Count = Schema.Struct({ n: Schema.Number })
export type Count = typeof Count.Type

export const POOL = 'bench'

/** Items a map's task runs at once. */
export const MAP_CONCURRENCY = 16
export const PARALLEL_MEMBERS = 8
export const CHILD_WORKFLOWS = 20

/** The workflows declared below, by the name the harness starts them. */
export type Workload = 'sequential' | 'tasks' | 'parallel' | 'map' | 'children'

/** Handler calls one run of a workload makes when nothing is retried. */
export function handlerCalls(workload: Workload, input: Count) {
  switch (workload) {
    case 'sequential':
    case 'tasks':
      return 5
    case 'parallel':
      return PARALLEL_MEMBERS
    case 'map':
      return input.n
    case 'children':
      return CHILD_WORKFLOWS * 3
  }
}

/**
 * Handler calls since the last `expect`, counted in the process. The last
 * handler of a batch is the earliest moment its runs can have ended, so a
 * harness waits for it here and reads the store only after: nothing polls the
 * store while the engine under measurement works.
 */
export const calls = (() => {
  let count = 0
  let target = Infinity
  let reached = () => {}
  return {
    get count() {
      return count
    },
    hit() {
      count += 1
      if (count === target) reached()
    },
    /** Resets the count; the promise resolves at the `total`th call. */
    expect(total: number) {
      count = 0
      target = total
      return new Promise<void>((resolve) => {
        reached = resolve
        if (total === 0) resolve()
      })
    },
  }
})()

export function items(count: number): Count[] {
  return Array.from({ length: count }, (_, n) => ({ n }))
}

// Handlers do no work, so what is measured is the engine.
const step = ({ n }: Count) =>
  Effect.sync(() => {
    calls.hit()
    return { n: n + 1 }
  })

const activity = { input: Count, output: Count, handler: step }

export const Increment = task({
  name: 'bench.increment',
  pool: POOL,
  input: Count,
  output: Count,
  handler: step,
})

export const Sequential = workflow(
  { name: 'bench.sequential', pool: POOL, input: Count, output: Count },
  function* (w) {
    const a = yield* w.activity('a', { ...activity, from: w.input })
    const b = yield* w.activity('b', { ...activity, from: a })
    const c = yield* w.activity('c', { ...activity, from: b })
    const d = yield* w.activity('d', { ...activity, from: c })
    return yield* w.activity('e', { ...activity, from: d })
  },
)

export const Tasks = workflow(
  { name: 'bench.tasks', pool: POOL, input: Count, output: Count },
  function* (w) {
    const a = yield* w.task('a', Increment, { input: w.input })
    const b = yield* w.task('b', Increment, { input: a })
    const c = yield* w.task('c', Increment, { input: b })
    const d = yield* w.task('d', Increment, { input: c })
    return yield* w.task('e', Increment, { input: d })
  },
)

export const Parallel = workflow(
  { name: 'bench.parallel', pool: POOL, input: Count, output: Count },
  function* (w) {
    const fan = yield* w.parallel('fan', {
      members: (p) => ({
        m1: p.activity({ ...activity, from: w.input }),
        m2: p.activity({ ...activity, from: w.input }),
        m3: p.activity({ ...activity, from: w.input }),
        m4: p.activity({ ...activity, from: w.input }),
        m5: p.activity({ ...activity, from: w.input }),
        m6: p.activity({ ...activity, from: w.input }),
        m7: p.activity({ ...activity, from: w.input }),
        m8: p.activity({ ...activity, from: w.input }),
      }),
    })
    return Effect.map(fan, (members) => ({
      n: Object.values(members).length,
    }))
  },
)

/** One `Increment` run for each of `n` items. */
export const MapTask = workflow(
  { name: 'bench.map', pool: POOL, input: Count, output: Count },
  function* (w) {
    const mapped = yield* w.mapTask('items', Increment, {
      item: Count,
      items: Effect.map(w.input, ({ n }) => items(n)),
      input: (item) => Effect.succeed(item),
      concurrency: MAP_CONCURRENCY,
    })
    return Effect.map(mapped, ({ items }) => ({ n: items.length }))
  },
)

export const Child = workflow(
  { name: 'bench.child', pool: POOL, input: Count, output: Count },
  function* (w) {
    const a = yield* w.activity('a', { ...activity, from: w.input })
    const b = yield* w.activity('b', { ...activity, from: a })
    return yield* w.activity('c', { ...activity, from: b })
  },
)

/** A parent that starts `CHILD_WORKFLOWS` runs of `Child` at once. */
export const Children = workflow(
  { name: 'bench.children', pool: POOL, input: Count, output: Count },
  function* (w) {
    const mapped = yield* w.mapWorkflow('children', Child, {
      item: Count,
      items: Effect.succeed(items(CHILD_WORKFLOWS)),
      input: (item) => Effect.succeed(item),
    })
    return Effect.map(mapped, ({ items }) => ({ n: items.length }))
  },
)

export const workloads = {
  sequential: Sequential,
  tasks: Tasks,
  parallel: Parallel,
  map: MapTask,
  children: Children,
} satisfies Record<Workload, unknown>

/** What the workers of the benchmark serve: every workload, each once. */
export const served = {
  workflows: [Sequential, Tasks, Parallel, MapTask, Child, Children],
  tasks: [Increment],
}
