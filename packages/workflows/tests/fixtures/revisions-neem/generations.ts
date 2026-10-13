import type * as Workflows from '@nmtjs/workflows'
import * as z from 'zod'

type Api = Pick<
  typeof Workflows,
  'defineTask' | 'defineWorkflow' | 'implementTask' | 'implementWorkflow'
>

type Hooks = {
  readonly record: (event: {
    readonly step: string
    readonly revision: string
  }) => void
  /** Resolves when a step may proceed; the first `hang` input never does. */
  readonly gate: (input: string) => Promise<void>
}

const text = z.string()

/**
 * One revision of the family, built with the caller's copy of the package: the
 * worker bundle and the test process each have their own.
 */
export function generation(
  api: Api,
  prefix: string,
  revision: string,
  pool: string,
  hooks: Hooks,
) {
  const stamp = (step: string, input: string) => {
    hooks.record({ step, revision })
    return `${input}|${step}@${revision}`
  }

  const task = api.defineTask({
    name: `${prefix}.task`,
    revision,
    input: text,
    output: text,
  })
  const taskImplementation = api.implementTask(task, {
    pool,
    handler: async (input) => stamp('task', input),
  })

  const child = api
    .defineWorkflow({
      name: `${prefix}.child`,
      revision,
      input: text,
      output: text,
    })
    .activity('step', { input: text, output: text })
    .build()
  const childImplementation = api
    .implementWorkflow(child, { pool })
    .step(async (input) => stamp('child', input))
    .finish(({ step }) => step)

  const parent = api
    .defineWorkflow({
      name: `${prefix}.parent`,
      revision,
      input: text,
      output: z.array(text),
    })
    .activity('first', { input: text, output: text })
    .task('work', task)
    .workflow('sub', child)
    .build()
  const parentImplementation = api
    .implementWorkflow(parent, { pool })
    .first(async (input) => {
      await hooks.gate(input)
      return stamp('first', input)
    })
    .work(task)
    .sub(child)
    .finish(({ first, work, sub }) => [first, work, sub])

  return {
    task,
    child,
    parent,
    workflows: [parentImplementation, childImplementation],
    tasks: [taskImplementation],
  }
}
