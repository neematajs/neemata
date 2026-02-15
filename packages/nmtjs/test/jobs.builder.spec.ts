import { describe, expect, it } from 'vitest'

import { t } from '../../type/src/index.ts'
import { JobWorkerPool } from '../src/runtime/enums.ts'
import { createJob } from '../src/runtime/jobs/job.ts'
import { createStep, isJobStep } from '../src/runtime/jobs/step.ts'

describe('jobs builder', () => {
  it('creates step metadata and detects valid steps', () => {
    const step = createStep({
      label: 'parse',
      input: t.object({ seed: t.number() }),
      output: t.object({ value: t.number() }),
      handler: async (_ctx, input) => ({ value: input.seed + 1 }),
    })

    expect(isJobStep(step)).toBe(true)
    expect(step.label).toBe('parse')
    expect(step.dependencies).toEqual({})
    expect(Object.isFrozen(step)).toBe(true)
  })

  it('builds job with linear + parallel steps metadata', () => {
    const step1 = createStep({
      label: 'step1',
      input: t.object({ seed: t.number() }),
      output: t.object({ a: t.number() }),
      handler: async (_ctx, input) => ({ a: input.seed + 1 }),
    })

    const step2 = createStep({
      label: 'step2',
      input: t.object({ seed: t.number(), a: t.number() }),
      output: t.object({ b: t.number() }),
      handler: async (_ctx, input) => ({ b: input.a + 10 }),
    })

    const step3 = createStep({
      label: 'step3',
      input: t.object({ seed: t.number(), a: t.number() }),
      output: t.object({ c: t.number() }),
      handler: async (_ctx, input) => ({ c: input.seed + input.a }),
    })

    const step4 = createStep({
      label: 'step4',
      input: t.object({
        seed: t.number(),
        a: t.number(),
        b: t.number(),
        c: t.number(),
      }),
      output: t.object({ done: t.number() }),
      handler: async (_ctx, input) => ({ done: input.b + input.c }),
    })

    const job = createJob({
      name: 'builder-shape',
      pool: JobWorkerPool.Compute,
      input: t.object({ seed: t.number() }),
      output: t.object({ done: t.number() }),
    })
      .step(step1)
      .steps(step2, step3)
      .step(step4)
      .return(({ result }) => ({ done: result.done }))

    expect(job.jobSteps).toHaveLength(4)
    expect(job.parallelGroups.get(1)).toBe(3)
    expect(job.parallelGroupByStepIndex.get(1)).toBe(1)
    expect(job.parallelGroupByStepIndex.get(2)).toBe(1)
    expect(job.parallelGroupByStepIndex.has(0)).toBe(false)
    expect(job.parallelGroupByStepIndex.has(3)).toBe(false)
  })

  it('stores conditional step only for .step calls', () => {
    const step1 = createStep({
      input: t.object({ seed: t.number() }),
      output: t.object({ a: t.number() }),
      handler: async (_ctx, input) => ({ a: input.seed + 1 }),
    })

    const step2 = createStep({
      input: t.object({ seed: t.number(), a: t.number() }),
      output: t.object({ b: t.number() }),
      handler: async (_ctx, input) => ({ b: input.a + 10 }),
    })

    const step3 = createStep({
      input: t.object({ seed: t.number(), a: t.number() }),
      output: t.object({ c: t.number() }),
      handler: async (_ctx, input) => ({ c: input.seed + input.a }),
    })

    const condition = () => true

    const job = createJob({
      name: 'builder-condition',
      pool: JobWorkerPool.Compute,
      input: t.object({ seed: t.number() }),
      output: t.object({
        a: t.number().optional(),
        b: t.number().optional(),
        c: t.number().optional(),
      }),
    })
      .step(step1, condition)
      .steps(step2, step3)
      .return(({ result }) => ({ a: result.a, b: result.b, c: result.c }))

    expect(job.conditions.has(0)).toBe(true)
    expect(job.conditions.has(1)).toBe(false)
    expect(job.conditions.has(2)).toBe(false)
  })
})
