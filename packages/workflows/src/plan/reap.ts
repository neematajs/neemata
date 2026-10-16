import type { StoredRun } from '../model.ts'
import type { DeadCommand, Plan } from '../store.ts'
import { isTerminal } from '../model.ts'
import { conclude, current, retire } from './attempt.ts'
import { planning } from './draft.ts'
import { failRun } from './finish.ts'
import { canonical } from './keys.ts'

/**
 * Ends what a dead command was to continue, as a last failure would: nothing
 * else will, because the command is delivered no more. The error is the one
 * its last delivery failed with, which is how a run whose code was changed
 * under its revision, or that no registered code can run, says so.
 *
 * `listed` is the command as a read of its own moment found it, and says
 * only which one is meant: what is ended, and with what error, is taken from
 * the dead command as it is loaded.
 *
 * `false` when nothing waits for the command any more, or when it is dead no
 * longer; otherwise the task runs a run failed here cancelled that wait for
 * their handlers.
 */
export function planReap(
  listed: DeadCommand,
): Plan<false | readonly StoredRun[]> {
  return planning<false | readonly StoredRun[]>((draft) => {
    // A retry or a requeue since the read took the command off the dead, and
    // what it stood for is decided by the command queued in its place:
    // failing that work now would fail the run that was just reopened. And
    // an id is only the store's word for a command: one that numbers them
    // gives the id again once it is set back to an earlier state, to a
    // command of another run, which is not the one that was found.
    const dead = draft.dead(listed.id)
    if (!dead || canonical(dead.command) !== canonical(listed.command)) {
      return false
    }
    const { command } = dead
    const error = dead.error ?? {
      message: `Workflow command [${dead.id}] was set aside after ${dead.deliveries} deliveries`,
    }

    if (command.kind === 'continueRun') {
      const run = draft.records(command.runId)?.run
      if (!run || isTerminal(run.status)) return false
      return failRun(draft, run, error).tasks
    }

    // An attempt that was superseded or settled is not this command's to
    // fail: a retry of the run made another, with a command of its own.
    // A dead command has no claim, so no handler of its attempt is running:
    // one its run's cancellation waits for has ended.
    const counted = current(draft, command)
    if (!counted) return retire(draft, command) ? [] : false
    draft.updateAttempt(counted.attempt, {
      status: 'failed',
      error,
      completedAt: draft.now,
    })
    conclude(draft, counted, { status: 'failed', error })
    return []
  })
}

/**
 * Queues a dead command again, as it is loaded. A command queued for the
 * work of a dead one takes it off the dead, so this is all a requeue is.
 *
 * `false` when no dead command has the id: it was queued again already, and
 * a second command for its work could be claimed beside the first.
 */
export function planRequeue(id: string): Plan<boolean> {
  return planning<boolean>((draft) => {
    const dead = draft.dead(id)
    if (!dead) return false
    draft.enqueue(dead.command)
    return true
  })
}
