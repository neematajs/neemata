import type {
  AttemptCommand,
  RetryPolicy,
  StoredError,
  StoredRun,
} from '../model.ts'
import type { Registry } from '../program.ts'
import type { Claim, Plan, ReadScope, UnitRead } from '../store.ts'
import type { Draft } from './draft.ts'
import { continueRun, isTerminal, parseDurationMs } from '../model.ts'
import { planning } from './draft.ts'
import { finishRun } from './finish.ts'

export type Outcome =
  | { readonly _tag: 'Completed'; readonly output: unknown }
  | { readonly _tag: 'Failed'; readonly error: StoredError }
  | { readonly _tag: 'TimedOut'; readonly error: StoredError }

export type Settled =
  /** The outcome was recorded and the work is settled. */
  | 'settled'
  /** The failure was recorded and another attempt is queued. */
  | 'retrying'
  /** The attempt no longer counts; its command was dropped. */
  | 'stale'

function retryDelayMs(retry: RetryPolicy, failedAttemptNumber: number) {
  const base = parseDurationMs(retry.delay) ?? 0
  return retry.backoff === 'exponential'
    ? base * 2 ** Math.max(0, failedAttemptNumber - 1)
    : base
}

/** A run that is ending leaves its attempts to its cancellation pass. */
export function ending(run: StoredRun | undefined): boolean {
  return !run || isTerminal(run.status) || run.status === 'cancelling'
}

/** The unit of work an attempt command names: its run, node, child, attempt. */
export function unitOf({
  runId,
  nodeName,
  childKey,
  attemptId,
}: AttemptCommand): UnitRead {
  return { runId, nodeName, childKey, attemptId }
}

/**
 * The unit the attempt is of, and nothing else of its run: settling decides
 * from that alone. A task run's key is loaded when it is released.
 */
export const settleScope = (command: AttemptCommand): ReadScope => ({
  units: [unitOf(command)],
})

/**
 * What an attempt command stands for, while its attempt still counts: it is
 * the one its child waits for, and its run still wants the work. Read from
 * the command's unit, or from its run when that is loaded whole.
 */
export function current(draft: Draft, command: AttemptCommand) {
  const { attemptId } = command
  const { run, node, child, attempt } = draft.unit(unitOf(command))
  if (
    !run ||
    !node ||
    !child ||
    !attempt ||
    ending(run) ||
    attempt.status !== 'started' ||
    child.currentAttemptId !== attemptId
  ) {
    return undefined
  }
  return { run, node, child, attempt }
}

type Result =
  | { readonly status: 'completed'; readonly output: unknown }
  | { readonly status: 'failed'; readonly error: StoredError }

/**
 * Settles the work its last attempt came to: the child, the node unless it
 * waits for other children, and the run when the work is all of it. All of
 * it is of the attempt's unit, which is what `current` read.
 */
export function conclude(
  draft: Draft,
  { run, node, child }: NonNullable<ReturnType<typeof current>>,
  result: Result,
) {
  draft.updateChild(child, result)
  // A parallel node waits for its other members: its pass settles it.
  if (node.kind !== 'parallel') draft.updateNode(node, result)
  // A task run is this one chain of attempts, so its end is the run's.
  if (run.kind === 'task') finishRun(draft, run, result)
  else draft.enqueue(continueRun(run))
}

/**
 * Records what an attempt came to. Only the delivery holding the command's
 * claim may settle: the claim is acknowledged in the same commit, so a
 * delivery that lost it changes nothing.
 *
 * The retry policy is that of the code that ran the attempt, which is why the
 * registry is asked: a task's own policy is known only where the task is.
 */
export function planSettle(
  registry: Registry,
  claim: Claim<AttemptCommand>,
  outcome: Outcome,
): Plan<Settled> {
  const { command } = claim
  const { runId, nodeName, childKey } = command
  const retry = registry.executable(command)?.retry

  return planning<Settled>((draft) => {
    draft.ack(claim)

    const counted = current(draft, command)
    if (!counted) return 'stale'
    const { child, attempt } = counted

    const completedAt = draft.now
    if (outcome._tag === 'Completed') {
      const { output } = outcome
      draft.updateAttempt(attempt, { status: 'completed', output, completedAt })
      conclude(draft, counted, { status: 'completed', output })
      return 'settled'
    }

    const { error } = outcome
    draft.updateAttempt(attempt, {
      status: outcome._tag === 'TimedOut' ? 'timedOut' : 'failed',
      error,
      completedAt,
    })

    if (retry && attempt.retryAttemptNumber < retry.attempts) {
      const successor = draft.createAttempt({
        id: draft.id('attempt'),
        runId,
        nodeName,
        childKey,
        attemptNumber: attempt.attemptNumber + 1,
        retryAttemptNumber: attempt.retryAttemptNumber + 1,
        input: attempt.input,
      })
      draft.updateChild(child, {
        currentAttemptId: successor.id,
        attemptCount: child.attemptCount + 1,
      })
      const delayMs = retryDelayMs(retry, attempt.retryAttemptNumber)
      draft.enqueue(
        { ...command, attemptId: successor.id },
        delayMs > 0 ? draft.now + delayMs : undefined,
      )
      return 'retrying'
    }

    conclude(draft, counted, { status: 'failed', error })
    return 'settled'
  })
}
