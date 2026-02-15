import { JobWorkerPool, n, t } from 'nmtjs'

type JobKind = 'quick' | 'slow' | 'checkpoint' | 'hung'

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
    data: async (_, __, progress) => {
      const state = progress as { tick?: number }
      if (typeof state.tick !== 'number') state.tick = 0
      return { progress: state }
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
        const state = data.progress as { tick: number }

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
    data: async (_, __, progress) => {
      const state = progress as { index?: number; failed?: boolean }
      if (typeof state.index !== 'number') state.index = 0
      if (typeof state.failed !== 'boolean') state.failed = false
      return { progress: state }
    },
  })
  .step(
    n.step({
      input: t.object({ total: t.number(), failAt: t.number() }),
      output: t.object({ processed: t.number() }),
      dependencies: { saveProgress: n.inject.saveJobProgress },
      handler: async ({ saveProgress }, input, data) => {
        const state = data.progress as { index: number; failed: boolean }

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

export const jobs = { quick, slow, checkpoint, hung } as const

export function resolveJobByKind(kind: string) {
  if (kind === 'quick') return jobs.quick
  if (kind === 'slow') return jobs.slow
  if (kind === 'checkpoint') return jobs.checkpoint
  if (kind === 'hung') return jobs.hung

  throw new Error(`Invalid job kind: ${kind}`)
}

export type { JobKind }
