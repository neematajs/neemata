import * as Effect from 'effect/Effect'

import type { DefinitionConflict } from '../errors.ts'
import type { AttemptCommand } from '../model.ts'
import type { AttemptInfo, Executable, Registry } from '../program.ts'
import type { Claim, Plan, ReadScope } from '../store.ts'
import { current, retire, unitOf } from './attempt.ts'
import { drift, revisionKey } from './definitions.ts'
import { planning } from './draft.ts'

/**
 * No registered code may do the work. Nothing was written and the command is
 * still claimed: the caller releases it with `error`, so it is delivered
 * again and set aside if that keeps happening.
 */
export type Unroutable = {
  readonly _tag: 'Unroutable'
  /** Set when code is registered, and is not what the run was created with. */
  readonly error?: DefinitionConflict
}

export type Begun =
  /** The work began: the handler runs, and its outcome is settled. */
  | {
      readonly _tag: 'Begun'
      readonly executable: Executable
      readonly attempt: AttemptInfo
    }
  /** The attempt no longer counts; its command was dropped. */
  | { readonly _tag: 'Stale' }
  | Unroutable

const unstopped = Effect.succeed(undefined)

/**
 * The attempt's unit, and the manifest its revision is checked against:
 * nothing else of its run, whose other work has no say in whether this
 * attempt begins.
 */
export function beginScope(command: AttemptCommand): ReadScope {
  const { name, revision } = command
  const kind = command.kind === 'runTask' ? 'task' : 'workflow'
  return {
    units: [unitOf(command)],
    definitions:
      revision === undefined ? [] : [revisionKey({ kind, name, revision })],
  }
}

/**
 * Decides whether the handler of a claimed attempt runs, and records that the
 * work began. It is asked again whenever a delivery doubts its attempt, so it
 * is the one place that drops the command of work nobody waits for.
 *
 * Only the delivery that holds the claim is told to begin: for any other the
 * commit fails with `StaleClaim`.
 */
export function planBegin(
  registry: Registry,
  claim: Claim<AttemptCommand>,
): Plan<Begun> {
  const { command } = claim
  const executable = registry.executable(command)
  // The program holding the handler: a task, or an activity's workflow.
  const program =
    command.kind === 'runTask'
      ? registry.task(command)
      : registry.workflow(command)

  return planning<Begun>((draft) => {
    const counted = current(draft, command)
    if (!counted) {
      // Asked before the handler begins, or once it has stopped: no handler
      // of this delivery runs, so a cancellation waiting for it is answered.
      retire(draft, command)
      draft.ack(claim)
      return { _tag: 'Stale' }
    }
    if (!executable) return { _tag: 'Unroutable' }

    const { run, attempt } = counted
    // A handler of code the run was not created with never runs.
    const error = drift(draft, run, program?.definition)
    if (error) return { _tag: 'Unroutable', error }

    // Nothing coordinates a task run: its first attempt is what starts it.
    if (run.kind === 'task' && run.status === 'queued') {
      draft.updateRun(run, { status: 'running' })
    }
    // A delivery whose lease ended while it waited is another's by now: it
    // must not learn that the work is its to do, so the claim is checked in
    // the commit itself, where no pause can follow the check.
    draft.hold(claim)
    const { runId, nodeName, childKey } = command
    return {
      _tag: 'Begun',
      executable,
      attempt: {
        runId,
        nodeName,
        childKey,
        attemptNumber: attempt.attemptNumber,
        // Unambiguous whatever the names contain, which a joined path is not.
        idempotencyKey: JSON.stringify([runId, nodeName, childKey]),
        // Nothing stops a handler but a worker, which says why itself.
        stopReason: unstopped,
      },
    }
  })
}
