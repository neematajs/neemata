import type {
  PruneTerminalRunsParams,
  TerminalRunStatus,
  WorkflowStore,
} from '../../runtime/store.ts'
import type { ClaimedQueueItem, QueueItem } from './commands.ts'
import type { State } from './state.ts'
import { isTerminalRunStatus } from '../../runtime/status.ts'

const DEFAULT_PRUNE_BATCH_SIZE = 100
const DEFAULT_PRUNE_STATUSES = [
  'completed',
  'cancelled',
  'failed',
] as const satisfies readonly TerminalRunStatus[]

function normalizePruneBatchSize(batchSize: number | undefined) {
  if (batchSize === undefined) return DEFAULT_PRUNE_BATCH_SIZE
  if (!Number.isInteger(batchSize) || batchSize < 1) return 0
  return batchSize
}

function normalizePruneStatuses(
  statuses: PruneTerminalRunsParams['statuses'],
): readonly TerminalRunStatus[] {
  const unique = new Set<TerminalRunStatus>()
  for (const status of statuses ?? DEFAULT_PRUNE_STATUSES) {
    if (DEFAULT_PRUNE_STATUSES.includes(status)) unique.add(status)
  }
  return Array.from(unique)
}

/** A family is every run linked to its roots by `parentRunId` or `rootRunId`. */
function collectRunFamilyIds(state: State, rootIds: readonly string[]) {
  const { runs } = state

  const familyIds = new Set(rootIds)
  let checkedSize = -1
  while (checkedSize !== familyIds.size) {
    checkedSize = familyIds.size
    for (const run of runs.values()) {
      if (
        (run.parentRunId !== undefined && familyIds.has(run.parentRunId)) ||
        familyIds.has(run.rootRunId)
      ) {
        familyIds.add(run.id)
      }
    }
  }
  return familyIds
}

/**
 * Every run whose family holds a non-terminal run, found by climbing the same
 * links `collectRunFamilyIds` descends. Each run is visited once, where walking
 * every candidate's family would be quadratic.
 */
function collectLiveFamilyRunIds(state: State) {
  const { runs } = state

  const liveIds = new Set<string>()
  const pending: string[] = []
  for (const run of runs.values()) {
    if (!isTerminalRunStatus(run.status)) pending.push(run.id)
  }
  while (pending.length > 0) {
    const runId = pending.pop()!
    if (liveIds.has(runId)) continue
    liveIds.add(runId)
    const run = runs.get(runId)
    if (!run) continue
    if (run.parentRunId !== undefined) pending.push(run.parentRunId)
    pending.push(run.rootRunId)
  }
  return liveIds
}

function isTerminalFamily(state: State, familyRunIds: ReadonlySet<string>) {
  return Array.from(familyRunIds).every((familyRunId) => {
    const familyRun = state.runs.get(familyRunId)
    return familyRun !== undefined && isTerminalRunStatus(familyRun.status)
  })
}

function deleteRunTrees(state: State, treeIds: ReadonlySet<string>) {
  const {
    runs,
    nodes,
    attempts,
    children,
    runIdempotencyKeys,
    activeUniqueRunKeys,
    allUniqueRunKeys,
    runLeases,
    continueRunCommands,
    attemptCommands,
    claimedContinueRunCommands,
    claimedAttemptCommands,
  } = state

  if (treeIds.size === 0) return

  for (const runId of treeIds) {
    runs.delete(runId)
    runLeases.delete(runId)
  }
  for (const [key, runId] of runIdempotencyKeys) {
    if (treeIds.has(runId)) runIdempotencyKeys.delete(key)
  }
  for (const [key, runId] of activeUniqueRunKeys) {
    if (treeIds.has(runId)) activeUniqueRunKeys.delete(key)
  }
  for (const [key, runId] of allUniqueRunKeys) {
    if (treeIds.has(runId)) allUniqueRunKeys.delete(key)
  }
  for (const [key, node] of nodes) {
    if (treeIds.has(node.runId)) nodes.delete(key)
  }
  for (const [attemptId, attempt] of attempts) {
    if (treeIds.has(attempt.runId)) attempts.delete(attemptId)
  }
  for (const [key, child] of children) {
    if (
      treeIds.has(child.runId) ||
      (child.childRunId !== undefined && treeIds.has(child.childRunId))
    ) {
      children.delete(key)
    }
  }
  deleteQueueItemsForRunIds(continueRunCommands, treeIds)
  deleteQueueItemsForRunIds(attemptCommands, treeIds)
  deleteClaimedCommandsForRunIds(claimedContinueRunCommands, treeIds)
  deleteClaimedCommandsForRunIds(claimedAttemptCommands, treeIds)
}

function deleteQueueItemsForRunIds<T extends { readonly runId: string }>(
  queue: QueueItem<T>[],
  runIds: ReadonlySet<string>,
) {
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (runIds.has(queue[index]!.payload.runId)) queue.splice(index, 1)
  }
}

function deleteClaimedCommandsForRunIds<T extends { readonly runId: string }>(
  queue: Map<string, ClaimedQueueItem<T>>,
  runIds: ReadonlySet<string>,
) {
  for (const [commandId, item] of queue) {
    if (runIds.has(item.payload.runId)) queue.delete(commandId)
  }
}

function sweepDeadCommands(state: State, deadBefore: number) {
  const { continueRunCommands, attemptCommands } = state

  sweepDeadQueueItems(continueRunCommands, deadBefore)
  sweepDeadQueueItems(attemptCommands, deadBefore)
}

function sweepDeadQueueItems<T extends { readonly runId: string }>(
  queue: QueueItem<T>[],
  deadBefore: number,
) {
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const item = queue[index]!
    // An unreaped dead command is the only thing left that can settle its run.
    if (
      item.deadAt !== undefined &&
      item.reapedAt !== undefined &&
      item.deadAt < deadBefore
    ) {
      queue.splice(index, 1)
    }
  }
}

type RetentionStore = Pick<WorkflowStore, 'pruneTerminalRuns' | 'deleteRun'>

export function createRetentionStore(state: State): RetentionStore {
  const { runs } = state

  return {
    async pruneTerminalRuns(params: PruneTerminalRunsParams) {
      const batchSize = normalizePruneBatchSize(params.batchSize)
      const statuses = normalizePruneStatuses(params.statuses)
      const deadBefore = params.olderThan
      if (batchSize < 1 || statuses.length === 0) {
        sweepDeadCommands(state, deadBefore)
        return { deleted: 0 }
      }

      const liveIds = collectLiveFamilyRunIds(state)
      const roots = [...runs.values()]
        .filter(
          (run) =>
            run.parentRunId === undefined &&
            statuses.some((status) => status === run.status) &&
            run.updatedAt < params.olderThan &&
            // A detached child outlives its terminal root, so the root alone
            // does not make the family prunable.
            !liveIds.has(run.id),
        )
        .sort((left, right) => {
          const byUpdatedAt = left.updatedAt - right.updatedAt
          if (byUpdatedAt !== 0) return byUpdatedAt
          return left.id.localeCompare(right.id)
        })
        .slice(0, batchSize)
      const treeIds = collectRunFamilyIds(
        state,
        roots.map((run) => run.id),
      )
      deleteRunTrees(state, treeIds)
      sweepDeadCommands(state, deadBefore)
      return { deleted: roots.length }
    },

    async deleteRun(runId) {
      const run = runs.get(runId)
      if (!run) return { deleted: false }
      if (run.parentRunId !== undefined) {
        throw new Error(`Run [${runId}] is not a root run`)
      }

      const familyRunIds = collectRunFamilyIds(state, [runId])
      if (!isTerminalFamily(state, familyRunIds)) {
        throw new Error(`Run [${runId}] has non-terminal runs`)
      }

      deleteRunTrees(state, familyRunIds)
      return { deleted: true }
    },
  }
}
