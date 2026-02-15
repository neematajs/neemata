import { n, t } from 'nmtjs'

import { jobs, resolveJobByKind } from '../jobs.ts'

const dependencies = { jobManager: n.inject.jobManager }

export const startQuickJobProcedure = n.procedure({
  dependencies,
  input: t.object({ value: t.string() }),
  output: t.object({ id: t.string() }),
  handler: async ({ jobManager }, input) => {
    const queued = await jobManager.add(jobs.quick, input, { oneoff: false })
    return { id: queued.id }
  },
})

export const startSlowJobProcedure = n.procedure({
  dependencies,
  input: t.object({ ticks: t.number(), delayMs: t.number() }),
  output: t.object({ id: t.string() }),
  handler: async ({ jobManager }, input) => {
    const queued = await jobManager.add(jobs.slow, input, { oneoff: false })
    return { id: queued.id }
  },
})

export const startCheckpointJobProcedure = n.procedure({
  dependencies,
  input: t.object({ total: t.number(), failAt: t.number() }),
  output: t.object({ id: t.string() }),
  handler: async ({ jobManager }, input) => {
    const queued = await jobManager.add(jobs.checkpoint, input, {
      oneoff: false,
    })
    return { id: queued.id }
  },
})

export const startHungJobProcedure = n.procedure({
  dependencies,
  input: t.object({ durationMs: t.number() }),
  output: t.object({ id: t.string() }),
  handler: async ({ jobManager }, input) => {
    const queued = await jobManager.add(jobs.hung, input, { oneoff: false })
    return { id: queued.id }
  },
})

export const startParallelJobProcedure = n.procedure({
  dependencies,
  input: t.object({
    base: t.number(),
    delayMs: t.number(),
    failLeftTimes: t.number(),
    failRightTimes: t.number(),
  }),
  output: t.object({ id: t.string() }),
  handler: async ({ jobManager }, input) => {
    const queued = await jobManager.add(jobs.parallel, input, { oneoff: false })

    return { id: queued.id }
  },
})

export const startParallelConflictJobProcedure = n.procedure({
  dependencies,
  input: t.object({ base: t.number(), delayMs: t.number() }),
  output: t.object({ id: t.string() }),
  handler: async ({ jobManager }, input) => {
    const queued = await jobManager.add(jobs.parallelConflict, input, {
      oneoff: false,
    })

    return { id: queued.id }
  },
})

export const getJobProcedure = n.procedure({
  dependencies,
  input: t.object({ kind: t.string(), id: t.string() }),
  output: t.any(),
  handler: async ({ jobManager }, input) => {
    return jobManager.get(resolveJobByKind(input.kind), input.id)
  },
})

export const cancelJobProcedure = n.procedure({
  dependencies,
  input: t.object({ kind: t.string(), id: t.string() }),
  handler: async ({ jobManager }, input) => {
    await jobManager.cancel(resolveJobByKind(input.kind), input.id)
  },
})

export const retryJobProcedure = n.procedure({
  dependencies,
  input: t.object({
    kind: t.string(),
    id: t.string(),
    clearState: t.boolean(),
  }),
  handler: async ({ jobManager }, input) => {
    await jobManager.retry(resolveJobByKind(input.kind), input.id, {
      clearState: input.clearState,
    })
  },
})
