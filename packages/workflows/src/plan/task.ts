import type {
  DurationString,
  RetryPolicy,
  StoredRun,
  Timestamp,
} from '../model.ts'
import type { Draft } from './draft.ts'
import { SELF, TASK } from '../model.ts'

/**
 * Creates a task run with its first attempt queued. Nothing coordinates a
 * task run: it is one chain of attempts, and the attempt that ends the chain
 * ends the run.
 */
export function startTask(
  draft: Draft,
  fields: Omit<Parameters<Draft['createRun']>[0], 'kind'>,
  options: {
    /** A parent step's overrides of the task's own limits. */
    readonly retry?: RetryPolicy
    readonly timeout?: DurationString
    /** The first attempt is not delivered before this time. */
    readonly startAt?: Timestamp
  } = {},
): StoredRun {
  const run = draft.createRun({ ...fields, kind: 'task' })
  const { id: runId, name, revision, input } = run
  const { retry, timeout, startAt } = options
  const child = { runId, nodeName: TASK, childKey: SELF }
  const attemptId = draft.id('attempt')

  draft.createNode({
    runId,
    name: TASK,
    kind: 'task',
    status: 'running',
    input,
  })
  draft.createChild({
    ...child,
    kind: 'task',
    status: 'running',
    input,
    currentAttemptId: attemptId,
    attemptCount: 1,
  })
  draft.createAttempt({
    ...child,
    id: attemptId,
    attemptNumber: 1,
    retryAttemptNumber: 1,
    input,
  })
  draft.enqueue(
    {
      kind: 'runTask',
      name,
      ...(revision === undefined ? {} : { revision }),
      ...child,
      attemptId,
      input,
      ...(retry === undefined ? {} : { retry }),
      ...(timeout === undefined ? {} : { timeout }),
    },
    startAt,
  )

  return run
}
