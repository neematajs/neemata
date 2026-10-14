import { threadId } from 'node:worker_threads'

import { task, workflow } from '@nmtjs/workflows'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

/** What the worker's layer provides to the handlers. */
export class Greeter extends Context.Service<
  Greeter,
  { readonly greet: (name: string) => Effect.Effect<string> }
>()('neem/Greeter') {}

// Each step reports the thread it ran on, which is how a test tells the
// pools apart.
const Step = Schema.Struct({ text: Schema.String, thread: Schema.Number })
const text = { input: Schema.String, output: Schema.String }

export const Shout = task({
  name: 'neem.shout',
  pool: 'heavy',
  input: Schema.String,
  output: Step,
  handler: (text) =>
    Effect.as(Effect.logInfo(`shouting ${text}`), {
      text: text.toUpperCase(),
      thread: threadId,
    }),
})

export const Greeting = workflow(
  {
    name: 'neem.greeting',
    pool: 'io',
    input: Schema.String,
    output: Schema.Struct({ greeted: Step, shouted: Step }),
  },
  function* (w) {
    const greeted = yield* w.activity('greet', {
      input: Schema.String,
      output: Step,
      from: w.input,
      handler: (name) =>
        Effect.gen(function* () {
          const greeter = yield* Greeter
          return { text: yield* greeter.greet(name), thread: threadId }
        }),
    })
    const shouted = yield* w.task('shout', Shout, {
      input: Effect.map(greeted, ({ text }) => text),
    })

    return Effect.gen(function* () {
      return { greeted: yield* greeted, shouted: yield* shouted }
    })
  },
)

/** Names a pool the planner does not declare. */
export const Unplanned = task({
  ...text,
  name: 'neem.unplanned',
  pool: 'unplanned',
  handler: (text) => Effect.succeed(text),
})

const Unregistered = task({
  ...text,
  name: 'neem.unregistered',
  pool: 'io',
  handler: (text) => Effect.succeed(text),
})

/** Starts a task that no worker is given. */
export const Orphaned = workflow(
  { ...text, name: 'neem.orphaned', pool: 'io' },
  function* (w) {
    return yield* w.task('work', Unregistered, { input: w.input })
  },
)
