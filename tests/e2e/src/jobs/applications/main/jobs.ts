import { JobWorkerPool, n, t } from 'nmtjs'

type JobKind =
  | 'quick'
  | 'slow'
  | 'checkpoint'
  | 'hung'
  | 'parallel'
  | 'parallelConflict'

type SlowProgress = { tick?: number }
type SlowData = { progress: { tick: number } }

type CheckpointProgress = { index?: number; failed?: boolean }
type CheckpointData = { progress: { index: number; failed: boolean } }

type ParallelProgress = {
  leftRuns?: number
  rightRuns?: number
  leftFailures?: number
  rightFailures?: number
}
type ParallelData = {
  progress: {
    leftRuns: number
    rightRuns: number
    leftFailures: number
    rightFailures: number
  }
}

function ensureSlowProgress(
  progress: SlowProgress,
): asserts progress is { tick: number } {
  if (typeof progress.tick !== 'number') progress.tick = 0
}

function ensureCheckpointProgress(
  progress: CheckpointProgress,
): asserts progress is { index: number; failed: boolean } {
  if (typeof progress.index !== 'number') progress.index = 0
  if (typeof progress.failed !== 'boolean') progress.failed = false
}

function ensureParallelProgress(
  progress: ParallelProgress,
): asserts progress is {
  leftRuns: number
  rightRuns: number
  leftFailures: number
  rightFailures: number
} {
  if (typeof progress.leftRuns !== 'number') progress.leftRuns = 0
  if (typeof progress.rightRuns !== 'number') progress.rightRuns = 0
  if (typeof progress.leftFailures !== 'number') progress.leftFailures = 0
  if (typeof progress.rightFailures !== 'number') progress.rightFailures = 0
}

async function wait(ms: number, signal: AbortSignal) {
  if (signal.aborted) throw new Error('Job cancelled')

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    const onAbort = () => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      reject(new Error('Job cancelled'))
    }

    signal.addEventListener('abort', onAbort, { once: true })
  })
}

const quick = n
  .job({
    name: 'playground-quick',
    pool: JobWorkerPool.Io,
    input: t.object({ value: t.string() }),
    output: t.object({ value: t.string() }),
  })
  .step(
    n.step({
      input: t.object({ value: t.string() }),
      output: t.object({ value: t.string() }),
      handler: async (_, input) => ({ value: input.value }),
    }),
  )
  .return(({ result }) => ({ value: String(result.value) }))

const slow = n
  .job({
    name: 'playground-slow',
    pool: JobWorkerPool.Io,
    input: t.object({ ticks: t.number(), delayMs: t.number() }),
    output: t.object({ ticks: t.number() }),
    progress: t.object({ tick: t.number().optional() }),
    data: async (_, __, progress: SlowProgress): Promise<SlowData> => {
      ensureSlowProgress(progress)
      return { progress }
    },
  })
  .step(
    n.step({
      input: t.object({ ticks: t.number(), delayMs: t.number() }),
      output: t.object({ ticks: t.number() }),
      dependencies: {
        signal: n.inject.jobAbortSignal,
        saveProgress: n.inject.saveJobProgress,
      },
      handler: async ({ signal, saveProgress }, input, data) => {
        const state = data.progress

        for (let tick = state.tick; tick < input.ticks; tick++) {
          await wait(input.delayMs, signal)
          state.tick = tick + 1
          await saveProgress()
        }

        return { ticks: state.tick }
      },
    }),
  )
  .return(({ result }) => ({ ticks: Number(result.ticks ?? 0) }))

const checkpoint = n
  .job({
    name: 'playground-checkpoint',
    pool: JobWorkerPool.Io,
    input: t.object({ total: t.number(), failAt: t.number() }),
    output: t.object({ processed: t.number() }),
    progress: t.object({
      index: t.number().optional(),
      failed: t.boolean().optional(),
    }),
    data: async (
      _,
      __,
      progress: CheckpointProgress,
    ): Promise<CheckpointData> => {
      ensureCheckpointProgress(progress)
      return { progress }
    },
  })
  .step(
    n.step({
      input: t.object({ total: t.number(), failAt: t.number() }),
      output: t.object({ processed: t.number() }),
      dependencies: { saveProgress: n.inject.saveJobProgress },
      handler: async ({ saveProgress }, input, data) => {
        const state = data.progress

        for (let index = state.index; index < input.total; index++) {
          if (index === input.failAt && !state.failed) {
            state.failed = true
            await saveProgress()
            throw new Error('Checkpoint fixture failure')
          }

          state.index = index + 1
          await saveProgress()
        }

        return { processed: state.index }
      },
    }),
  )
  .return(({ result }) => ({ processed: Number(result.processed ?? 0) }))

const hung = n
  .job({
    name: 'playground-hung',
    pool: JobWorkerPool.Io,
    input: t.object({ durationMs: t.number() }),
    output: t.object({ done: t.boolean() }),
  })
  .step(
    n.step({
      input: t.object({ durationMs: t.number() }),
      output: t.object({ done: t.boolean() }),
      handler: async (_, input) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, input.durationMs)
        })
        return { done: true }
      },
    }),
  )
  .return(({ result }) => ({ done: Boolean(result.done) }))

const parallel = n
  .job({
    name: 'playground-parallel',
    pool: JobWorkerPool.Io,
    input: t.object({
      base: t.number(),
      delayMs: t.number(),
      failLeftTimes: t.number(),
      failRightTimes: t.number(),
    }),
    output: t.object({
      left: t.number(),
      right: t.number(),
      total: t.number(),
      leftRuns: t.number(),
      rightRuns: t.number(),
    }),
    progress: t.object({
      leftRuns: t.number().optional(),
      rightRuns: t.number().optional(),
      leftFailures: t.number().optional(),
      rightFailures: t.number().optional(),
    }),
    data: async (_, __, progress: ParallelProgress): Promise<ParallelData> => {
      ensureParallelProgress(progress)
      return { progress }
    },
  })
  .step(
    n.step({
      input: t.object({
        base: t.number(),
        delayMs: t.number(),
        failLeftTimes: t.number(),
        failRightTimes: t.number(),
      }),
      output: t.object({
        base: t.number(),
        delayMs: t.number(),
        failLeftTimes: t.number(),
        failRightTimes: t.number(),
      }),
      handler: async (_, input) => ({
        base: input.base,
        delayMs: input.delayMs,
        failLeftTimes: input.failLeftTimes,
        failRightTimes: input.failRightTimes,
      }),
    }),
  )
  .steps(
    n.step({
      input: t.object({
        base: t.number(),
        delayMs: t.number(),
        failLeftTimes: t.number(),
        failRightTimes: t.number(),
      }),
      output: t.object({ left: t.number() }),
      dependencies: {
        signal: n.inject.jobAbortSignal,
        saveProgress: n.inject.saveJobProgress,
      },
      handler: async ({ signal, saveProgress }, input, data) => {
        const state = data.progress

        await wait(input.delayMs, signal)
        state.leftRuns += 1
        await saveProgress()

        if (state.leftFailures < input.failLeftTimes) {
          state.leftFailures += 1
          await saveProgress()
          throw new Error('Parallel fixture left failure')
        }

        return { left: input.base + 1 }
      },
    }),
    n.step({
      input: t.object({
        base: t.number(),
        delayMs: t.number(),
        failLeftTimes: t.number(),
        failRightTimes: t.number(),
      }),
      output: t.object({ right: t.number() }),
      dependencies: {
        signal: n.inject.jobAbortSignal,
        saveProgress: n.inject.saveJobProgress,
      },
      handler: async ({ signal, saveProgress }, input, data) => {
        const state = data.progress

        await wait(input.delayMs, signal)
        state.rightRuns += 1
        await saveProgress()

        if (state.rightFailures < input.failRightTimes) {
          state.rightFailures += 1
          await saveProgress()
          throw new Error('Parallel fixture right failure')
        }

        return { right: input.base + 2 }
      },
    }),
  )
  .step(
    n.step({
      input: t.object({
        base: t.number(),
        delayMs: t.number(),
        failLeftTimes: t.number(),
        failRightTimes: t.number(),
        left: t.number(),
        right: t.number(),
      }),
      output: t.object({
        left: t.number(),
        right: t.number(),
        total: t.number(),
        leftRuns: t.number(),
        rightRuns: t.number(),
      }),
      handler: async (_, input, data) => {
        const state = data.progress

        return {
          left: input.left,
          right: input.right,
          total: input.left + input.right,
          leftRuns: state.leftRuns,
          rightRuns: state.rightRuns,
        }
      },
    }),
  )
  .return(({ result }) => ({
    left: Number(result.left ?? 0),
    right: Number(result.right ?? 0),
    total: Number(result.total ?? 0),
    leftRuns: Number(result.leftRuns ?? 0),
    rightRuns: Number(result.rightRuns ?? 0),
  }))

const parallelConflict = n
  .job({
    name: 'playground-parallel-conflict',
    pool: JobWorkerPool.Io,
    input: t.object({ base: t.number(), delayMs: t.number() }),
    output: t.object({ shared: t.number() }),
  })
  .step(
    n.step({
      input: t.object({ base: t.number(), delayMs: t.number() }),
      output: t.object({ base: t.number(), delayMs: t.number() }),
      handler: async (_, input) => ({
        base: input.base,
        delayMs: input.delayMs,
      }),
    }),
  )
  .steps(
    n.step({
      input: t.object({ base: t.number(), delayMs: t.number() }),
      output: t.object({ shared: t.number() }),
      dependencies: { signal: n.inject.jobAbortSignal },
      handler: async ({ signal }, input) => {
        await wait(input.delayMs, signal)
        return { shared: input.base + 1 }
      },
    }),
    n.step({
      input: t.object({ base: t.number(), delayMs: t.number() }),
      output: t.object({ shared: t.number() }),
      dependencies: { signal: n.inject.jobAbortSignal },
      handler: async ({ signal }, input) => {
        await wait(input.delayMs, signal)
        return { shared: input.base + 2 }
      },
    }),
  )
  .return(({ result }) => ({ shared: Number(result.shared ?? 0) }))

export const jobs = {
  quick,
  slow,
  checkpoint,
  hung,
  parallel,
  parallelConflict,
} as const

export function resolveJobByKind(kind: string) {
  if (kind === 'quick') return jobs.quick
  if (kind === 'slow') return jobs.slow
  if (kind === 'checkpoint') return jobs.checkpoint
  if (kind === 'hung') return jobs.hung
  if (kind === 'parallel') return jobs.parallel
  if (kind === 'parallelConflict') return jobs.parallelConflict

  throw new Error(`Invalid job kind: ${kind}`)
}

export type { JobKind }
