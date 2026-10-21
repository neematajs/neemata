import type { StoredChild, StoredNode, StoredRun } from '../model.ts'
import type { Plan } from '../store.ts'
import {
  BlockerNotResumable,
  RunNotBlocked,
  RunNotFound,
  StaleRunVersion,
} from '../errors.ts'
import { continueRun, SELF } from '../model.ts'
import { planning, Refused } from './draft.ts'
import { MISMATCH } from './durable.ts'
import { reopenRun } from './retry.ts'

export type ResumeError =
  | BlockerNotResumable
  | RunNotBlocked
  | RunNotFound
  | StaleRunVersion

export type ResumeOptions = {
  /**
   * The run's version as the caller saw it: a resume decided on an older
   * view is refused. Every change to what blocks a run writes the run, so
   * the version covers its blockers, though not every change in its
   * children's runs.
   */
  readonly expectedVersion?: number
  /** The blocked operations to resume, by name; all of them when omitted. */
  readonly blockers?: readonly string[]
}

/** A record as it is written again: what it came to is forgotten. */
function cleared<Record extends object>(record: Record): Record {
  const {
    error: _error,
    output: _output,
    ...rest
  } = record as Record & { readonly error?: unknown; readonly output?: unknown }
  return rest as Record
}

/**
 * Unblocks a durable run. A run blocked for a replay mismatch is replayed
 * again by the code deployed now, and blocks again if that still does not
 * match. A blocked operation's failed run is reopened as itself, its
 * completed work kept, with a fresh retry budget and the limits the
 * operation gave it: its handlers keep their idempotency keys. Nothing of
 * the run's own lifetime is reset, so a run timeout counts the time it was
 * blocked.
 */
export function planResume(
  runId: string,
  { expectedVersion, blockers }: ResumeOptions = {},
): Plan<StoredRun, ResumeError> {
  return planning<StoredRun, ResumeError>((draft) => {
    const run = draft.records(runId)?.run
    if (!run) return new Refused(new RunNotFound({ runId }))
    if (run.status !== 'blocked') {
      return new Refused(new RunNotBlocked({ runId, status: run.status }))
    }
    if (expectedVersion !== undefined && expectedVersion !== run.version) {
      const { version } = run
      return new Refused(
        new StaleRunVersion({ runId, expectedVersion, version }),
      )
    }

    const blocked = draft
      .nodes(runId)
      .filter(({ operation }) => operation?.blocked)
    const named = blockers ?? blocked.map(({ name }) => name)
    const reopening: {
      readonly node: StoredNode
      readonly child: StoredChild
      readonly childRun: StoredRun
    }[] = []
    // Every one is checked before any is reopened: all or nothing.
    for (const name of named) {
      const node = draft.node(runId, name)
      if (!node?.operation?.blocked) {
        return new Refused(
          new BlockerNotResumable({
            runId,
            operation: name,
            reason: 'not-blocked',
          }),
        )
      }
      const child = draft.child(runId, name, SELF)
      const childRun =
        child?.childRunId === undefined
          ? undefined
          : draft.head(child.childRunId)
      if (!child || !childRun || childRun.status !== 'failed') {
        return new Refused(
          new BlockerNotResumable({
            runId,
            operation: name,
            reason: 'not-failed',
          }),
        )
      }
      // Work an operation started holds no unique key: only a run a client
      // starts does, so reopening it can make no second holder of one.
      reopening.push({ node, child, childRun })
    }

    for (const { node, child, childRun } of reopening) {
      const { blocked: _, ...operation } = node.operation!
      draft.updateNode(cleared(node), { status: 'waiting', operation })
      // The edge too: a child read as failed is never read again.
      draft.updateChild(cleared(child), { status: 'waiting' })
      reopenRun(draft, childRun, operation.limits ?? {})
    }

    // A mismatch is checked again by the pass this queues.
    const mismatched = run.error?.name === MISMATCH
    const left = blocked.length - reopening.length
    const { error: _, ...record } = run
    const resumed = draft.updateRun(mismatched ? record : run, {
      status: left > 0 ? 'blocked' : 'waiting',
    })
    draft.enqueue(continueRun(resumed))
    return resumed
  })
}
