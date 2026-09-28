import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '@nmtjs/workflows'
import * as z from 'zod'

const heavy = defineTask({
  name: 'neem-boot.heavy',
  input: z.string(),
  output: z.string(),
})
const unregistered = defineTask({
  name: 'neem-boot.unregistered',
  input: z.string(),
  output: z.string(),
})
const parent = defineWorkflow({
  name: 'neem-boot.parent',
  input: z.string(),
  output: z.string(),
})
  .task('work', unregistered)
  .build()

const heavyImpl = implementTask(heavy, {
  pool: 'heavy',
  handler: (input) => input,
})
const parentImpl = implementWorkflow(parent, { pool: 'io' })
  .work(unregistered, { input: (_outputs, input) => input })
  .finish(({ work }) => work)

// Chosen when the worker starts, so one build serves every registry; without
// a choice the registry is valid.
const invalid = process.env.WORKFLOWS_REGISTRY

export const registry = {
  workflows: () => (invalid === 'incomplete' ? [parentImpl] : []),
  tasks: () => (invalid === 'undeclared-pool' ? [heavyImpl] : []),
}
