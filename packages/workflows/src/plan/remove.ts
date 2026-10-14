import type { RunStatus, Timestamp } from '../model.ts'
import type { Family, Plan } from '../store.ts'
import { RunBusy, RunNotRoot } from '../errors.ts'
import { planning, Refused } from './draft.ts'

/**
 * A run of the family that still has work in flight, if any: one that has
 * not ended, or one a worker holds a command of. A family goes whole or not
 * at all, so one such run keeps all of it.
 *
 * A claim is guarded by nothing, so a command of the family may be claimed
 * after it was read. That is harmless for a family whose runs have all
 * ended, which the guard keeps true until the commit: its worker finds no
 * attempt that counts, then no run, and runs no handler.
 */
const busy = ({ activeRunId, claimedRunId }: Family) =>
  activeRunId ?? claimedRunId

/**
 * Deletes a root run with every run under it. `false` when no run has the
 * id; refused for a run that is not a root, and while anything of the family
 * is in flight.
 */
export function planDelete(runId: string): Plan<boolean, RunNotRoot | RunBusy> {
  return planning<boolean, RunNotRoot | RunBusy>((draft) => {
    const family = draft.family(runId)
    if (!family) return false
    if (family.root.parentRunId !== undefined) {
      return new Refused(new RunNotRoot({ runId }))
    }
    const busyRunId = busy(family)
    if (busyRunId !== undefined) {
      return new Refused(new RunBusy({ runId, busyRunId }))
    }
    draft.remove(family)
    return true
  })
}

export type Retention = {
  /** The root ended in one of these. */
  readonly statuses: readonly RunStatus[]
  /** The root was last written before this. */
  readonly updatedBefore: Timestamp
}

/**
 * Removes the family of a root that a sweep found old enough, when it still
 * is: the sweep read without a guard, so everything is decided again here.
 * `false` when the family stays, which is no failure of the sweep.
 */
export function planPrune(runId: string, retention: Retention): Plan<boolean> {
  const { statuses, updatedBefore } = retention

  return planning<boolean>((draft) => {
    const family = draft.family(runId)
    if (
      !family ||
      family.root.parentRunId !== undefined ||
      !statuses.includes(family.root.status) ||
      family.root.updatedAt >= updatedBefore ||
      busy(family) !== undefined
    ) {
      return false
    }
    draft.remove(family)
    return true
  })
}
