import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { durable, task, workflow } from '../../src/index.ts'

export const Step = Schema.Struct({ id: Schema.String, hard: Schema.Boolean })

export const Draft = task({
  name: 'durable.draft',
  revision: 'v1',
  pool: 'default',
  input: Step,
  output: Schema.Struct({ text: Schema.String, ok: Schema.Boolean }),
  handler: ({ id, hard }) => Effect.succeed({ text: `draft ${id}`, ok: !hard }),
})

export const Fix = workflow(
  {
    name: 'durable.fix',
    revision: 'v1',
    pool: 'default',
    input: Schema.String,
    output: Schema.String,
  },
  function* (w) {
    return yield* w.activity('fix', {
      input: Schema.String,
      output: Schema.String,
      from: w.input,
      handler: (id) => Effect.succeed(`fixed ${id}`),
    })
  },
)

/**
 * A durable workflow whose steps come from its input: each is drafted by a
 * task, and one that comes back not ok is fixed by a child workflow.
 */
export const Review = durable(
  {
    name: 'durable.review',
    revision: 'v1',
    pool: 'default',
    input: Schema.Struct({ steps: Schema.Array(Step) }),
    output: Schema.Array(Schema.String),
    tasks: [Draft],
    workflows: [Fix],
  },
  ({ steps }, d) =>
    Effect.gen(function* () {
      const notes: string[] = []
      // Steps come from the run's input; a step's outcome decides what follows.
      for (const step of steps) {
        const draft = yield* d.task(`draft:${step.id}`, Draft, step)
        notes.push(draft.text)
        if (!draft.ok)
          notes.push(yield* d.workflow(`fix:${step.id}`, Fix, step.id))
      }
      return notes
    }),
)
