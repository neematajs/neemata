import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '@nmtjs/workflows/effect'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

const heavy = defineTask({
  name: 'neem-boot.heavy',
  input: Schema.String,
  output: Schema.String,
})
const unregistered = defineTask({
  name: 'neem-boot.unregistered',
  input: Schema.String,
  output: Schema.String,
})
const parent = defineWorkflow({
  name: 'neem-boot.parent',
  input: Schema.String,
  output: Schema.String,
})
  .task('work', unregistered)
  .build()

const heavyImpl = implementTask(heavy, {
  pool: 'heavy',
  handler: (input) => Effect.succeed(input),
})
const parentImpl = implementWorkflow(parent, { pool: 'io' })
  .work(unregistered, { input: (_outputs, input) => input })
  .finish(({ work }) => Effect.succeed(work))

// Chosen when the worker starts, so one build serves every registry; without
// a choice the registry is valid.
const invalid = process.env.WORKFLOWS_REGISTRY

export const registry = {
  workflows: () => (invalid === 'incomplete' ? [parentImpl] : []),
  tasks: () => (invalid === 'undeclared-pool' ? [heavyImpl] : []),
}
