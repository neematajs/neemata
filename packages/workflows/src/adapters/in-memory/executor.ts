import type { AttemptCommand, ClaimedAttempt } from '../../runtime/commands.ts'
import type { AttemptExecutor } from '../../runtime/executors.ts'
import type { ClaimedQueueItem, QueueItem } from './commands.ts'
import type { State } from './state.ts'
import { DEFAULT_LEASE_MS } from '../../runtime/executors.ts'
import {
  claimQueued,
  compareAttemptCommands,
  matchesClaim,
  queueItem,
  reclaimExpiredLeases,
  releaseQueueItem,
} from './commands.ts'

function attemptCommandExists(state: State, attemptId: string) {
  const { attemptCommands, claimedAttemptCommands } = state

  return (
    attemptCommands.some((item) => item.payload.attemptId === attemptId) ||
    [...claimedAttemptCommands.values()].some(
      (item) => item.payload.attemptId === attemptId,
    )
  )
}

function claimedAttempt(
  state: State,
  item: QueueItem<AttemptCommand> | undefined,
  leaseMs: number,
):
  | {
      readonly claim: ClaimedAttempt
      readonly item: ClaimedQueueItem<AttemptCommand>
    }
  | undefined {
  const { id, now } = state

  if (!item) return undefined

  const leaseToken = id('attempt-claim-lease')
  return {
    claim: {
      id: item.id,
      command: item.payload,
      leaseToken,
    },
    item: {
      ...item,
      leaseToken,
      leaseExpiresAt: new Date(now().getTime() + leaseMs),
    },
  }
}

export function createAttemptExecutor(state: State): AttemptExecutor {
  const { id, now, runs, attemptCommands, claimedAttemptCommands, wake } = state

  return {
    async dispatchActivity(command, options) {
      if (attemptCommandExists(state, command.attemptId)) return
      attemptCommands.push(
        queueItem(state, id('activity-command'), command, options?.runAt),
      )
      if (options?.runAt === undefined || options.runAt <= new Date()) {
        wake.command('activity')
      }
    },
    async dispatchTask(command, options) {
      if (attemptCommandExists(state, command.attemptId)) return
      attemptCommands.push(
        queueItem(state, id('task-command'), command, options?.runAt),
      )
      if (options?.runAt === undefined || options.runAt <= new Date()) {
        wake.command('task')
      }
    },
    async claim(worker) {
      function eligible(command: AttemptCommand) {
        if (command.kind === 'taskAttempt') {
          return worker.taskNames.includes(command.taskName)
        }
        return (
          worker.workflowNames.includes(command.workflowName) &&
          (worker.activityNames === undefined ||
            worker.activityNames.includes(command.activityName))
        )
      }
      reclaimExpiredLeases(
        state,
        claimedAttemptCommands,
        attemptCommands,
        eligible,
      )
      const date = now()
      const claimed = claimedAttempt(
        state,
        claimQueued(
          attemptCommands,
          (queued) =>
            (queued.runAt === undefined || queued.runAt <= date) &&
            eligible(queued.payload),
          compareAttemptCommands,
        ),
        worker.leaseMs,
      )
      if (!claimed) return null
      claimedAttemptCommands.set(claimed.claim.id, claimed.item)
      return claimed.claim
    },
    async heartbeat(attempt, leaseMs = DEFAULT_LEASE_MS) {
      const claimed = claimedAttemptCommands.get(attempt.id)
      if (!claimed || !matchesClaim(claimed, attempt)) {
        throw new Error('Workflow attempt heartbeat lease lost')
      }
      claimedAttemptCommands.set(attempt.id, {
        ...claimed,
        leaseExpiresAt: new Date(now().getTime() + leaseMs),
      })
      return { runStatus: runs.get(attempt.command.runId)?.status ?? 'queued' }
    },
    async ack(attempt) {
      if (!matchesClaim(claimedAttemptCommands.get(attempt.id), attempt)) {
        throw new Error('Stale workflow command ack')
      }
      claimedAttemptCommands.delete(attempt.id)
    },
    async release(attempt, options) {
      const claimed = claimedAttemptCommands.get(attempt.id)
      if (!claimed || !matchesClaim(claimed, attempt)) {
        return
      }

      claimedAttemptCommands.delete(attempt.id)
      attemptCommands.push(releaseQueueItem(state, claimed, options))
    },
    async deleteUnclaimed({ runId }) {
      let deleted = 0
      for (let index = attemptCommands.length - 1; index >= 0; index -= 1) {
        if (attemptCommands[index]?.payload.runId !== runId) continue
        attemptCommands.splice(index, 1)
        deleted += 1
      }
      return deleted
    },
  }
}
