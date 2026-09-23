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

function collectRunTreeIds(state: State, rootIds: readonly string[]) {
  const { runs } = state

  const treeIds = new Set(rootIds)
  let checkedSize = -1
  while (checkedSize !== treeIds.size) {
    checkedSize = treeIds.size
    for (const run of runs.values()) {
      if (run.parentRunId && treeIds.has(run.parentRunId)) {
        treeIds.add(run.id)
      }
    }
  }
  return treeIds
}

function collectRunDescendantIds(state: State, rootId: string) {
  const { runs } = state

  const descendantIds = new Set([rootId])
  let checkedSize = -1
  while (checkedSize !== descendantIds.size) {
    checkedSize = descendantIds.size
    for (const run of runs.values()) {
      if (
        (run.parentRunId !== undefined && descendantIds.has(run.parentRunId)) ||
        descendantIds.has(run.rootRunId)
      ) {
        descendantIds.add(run.id)
      }
    }
  }
  return descendantIds
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
    if (item.deadAt !== undefined && item.deadAt.getTime() < deadBefore) {
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
      const deadBefore = params.olderThan.getTime()
      if (batchSize < 1 || statuses.length === 0) {
        sweepDeadCommands(state, deadBefore)
        return { deleted: 0 }
      }

      const roots = [...runs.values()]
        .filter(
          (run) =>
            run.parentRunId === undefined &&
            statuses.some((status) => status === run.status) &&
            run.updatedAt < params.olderThan,
        )
        .sort((left, right) => {
          const byUpdatedAt =
            left.updatedAt.getTime() - right.updatedAt.getTime()
          if (byUpdatedAt !== 0) return byUpdatedAt
          return left.id.localeCompare(right.id)
        })
        .slice(0, batchSize)
      const treeIds = collectRunTreeIds(
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

      const familyRunIds = collectRunDescendantIds(state, runId)
      if (
        Array.from(familyRunIds).some((familyRunId) => {
          const familyRun = runs.get(familyRunId)
          return (
            familyRun === undefined || !isTerminalRunStatus(familyRun.status)
          )
        })
      ) {
        throw new Error(`Run [${runId}] has non-terminal runs`)
      }

      deleteRunTrees(state, familyRunIds)
      return { deleted: true }
    },
  }
}
