import { t } from '../../type/src/index.ts'
import { JobWorkerPool } from '../src/runtime/enums.ts'
import { createJob } from '../src/runtime/jobs/job.ts'
import { createStep } from '../src/runtime/jobs/step.ts'

type Assert<T extends true> = T
type IsAssignable<From, To> = From extends To ? true : false

const step1 = createStep({
  input: t.object({ seed: t.number() }),
  output: t.object({ a: t.number() }),
  handler: async (_ctx, input) => ({ a: input.seed + 1 }),
})

const step2 = createStep({
  input: t.object({ seed: t.number(), a: t.number() }),
  output: t.object({ b: t.string() }),
  handler: async () => ({ b: 'ok' }),
})

const step3 = createStep({
  input: t.object({ seed: t.number(), a: t.number() }),
  output: t.object({ c: t.boolean() }),
  handler: async () => ({ c: true }),
})

const step4 = createStep({
  input: t.object({
    seed: t.number(),
    a: t.number(),
    b: t.string(),
    c: t.boolean(),
  }),
  output: t.object({ done: t.number() }),
  handler: async () => ({ done: 1 }),
})

const job = createJob({
  name: 'types-parallel',
  pool: JobWorkerPool.Compute,
  input: t.object({ seed: t.number() }),
  output: t.object({ done: t.number() }),
})
  .step(step1)
  .steps(step2, step3)
  .step(step4)
  .return(({ result }) => ({ done: result.done }))

type _ComposedResultHasParallelOutputs = Assert<
  IsAssignable<
    { seed: number; a: number; b: string; c: boolean; done: number },
    typeof job._.result
  >
>

createJob({
  name: 'types-invalid',
  pool: JobWorkerPool.Compute,
  input: t.object({ seed: t.number() }),
  output: t.object({ done: t.number() }),
})
  // @ts-expect-error: .steps requires at least two steps
  .steps(step1)
  .return()
