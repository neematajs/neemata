import type { AttemptCommand, ContinueRunCommand } from '../commands.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { State } from './state.ts'
import { AttemptLeaseLostError, StaleAckError } from '../errors.ts'
import { DEFAULT_LEASE_MS } from '../executors.ts'
import {
  absorbContinue,
  claimQueued,
  compareAttemptCommands,
  dispatchAttempt,
  enqueueContinue,
  reclaimExpiredLeases,
  releaseQueueItem,
  removeWhere,
} from './queue.ts'

export function createRunCoordinationExecutor(
  state: State,
): RunCoordinationExecutor {
  return {
    async enqueue(command) {
      enqueueContinue(state, command)
    },
    async enqueueDelayed(command, runAt) {
      enqueueContinue(state, command, runAt)
    },
    async claim(worker) {
      const eligible = (command: ContinueRunCommand) =>
        worker.workflowNames.includes(command.workflowName)
      reclaimExpiredLeases(
        state,
        state.claimedContinueCommands,
        state.continueCommands,
        eligible,
      )

      const at = state.now()
      const item = claimQueued(
        state.continueCommands,
        (queued) =>
          eligible(queued.payload) &&
          (queued.runAt === undefined || queued.runAt <= at),
      )
      if (!item) return null

      const claim = {
        id: item.id,
        command: item.payload,
        leaseToken: state.newId('continue-lease'),
      }
      state.claimedContinueCommands.set(claim.id, {
        ...item,
        leaseToken: claim.leaseToken,
        leaseExpiresAt: new Date(at.getTime() + worker.leaseMs),
      })
      return claim
    },
    async ack(command) {
      const claimed = state.claimedContinueCommands.get(command.id)
      if (claimed?.leaseToken !== command.leaseToken) {
        throw new StaleAckError()
      }
      state.claimedContinueCommands.delete(command.id)
    },
    async release(command, options) {
      const claimed = state.claimedContinueCommands.get(command.id)
      if (!claimed || claimed.leaseToken !== command.leaseToken) return

      state.claimedContinueCommands.delete(command.id)
      const released = releaseQueueItem(state, claimed, options)
      if (released.deadAt !== undefined) {
        state.continueCommands.push(released)
        return
      }

      absorbContinue(state, released)
    },
  }
}

export function createAttemptExecutor(state: State): AttemptExecutor {
  return {
    async dispatchActivity(command, options) {
      dispatchAttempt(state, command, options?.runAt)
    },
    async dispatchTask(command, options) {
      dispatchAttempt(state, command, options?.runAt)
    },
    async claim(worker) {
      const eligible = (command: AttemptCommand) => {
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
        state.claimedAttemptCommands,
        state.attemptCommands,
        eligible,
      )

      const at = state.now()
      const item = claimQueued(
        state.attemptCommands,
        (queued) =>
          (queued.runAt === undefined || queued.runAt <= at) &&
          eligible(queued.payload),
        compareAttemptCommands,
      )
      if (!item) return null

      const claim = {
        id: item.id,
        command: item.payload,
        leaseToken: state.newId('attempt-claim-lease'),
      }
      state.claimedAttemptCommands.set(claim.id, {
        ...item,
        leaseToken: claim.leaseToken,
        leaseExpiresAt: new Date(state.now().getTime() + worker.leaseMs),
      })
      return claim
    },
    async heartbeat(attempt, leaseMs = DEFAULT_LEASE_MS) {
      const claimed = state.claimedAttemptCommands.get(attempt.id)
      if (!claimed || claimed.leaseToken !== attempt.leaseToken) {
        throw new AttemptLeaseLostError()
      }

      state.claimedAttemptCommands.set(attempt.id, {
        ...claimed,
        leaseExpiresAt: new Date(state.now().getTime() + leaseMs),
      })
      return {
        runStatus: state.runs.get(attempt.command.runId)?.status ?? 'queued',
      }
    },
    async ack(attempt) {
      const claimed = state.claimedAttemptCommands.get(attempt.id)
      if (claimed?.leaseToken !== attempt.leaseToken) {
        throw new StaleAckError()
      }
      state.claimedAttemptCommands.delete(attempt.id)
    },
    async release(attempt, options) {
      const claimed = state.claimedAttemptCommands.get(attempt.id)
      if (!claimed || claimed.leaseToken !== attempt.leaseToken) return

      state.claimedAttemptCommands.delete(attempt.id)
      state.attemptCommands.push(releaseQueueItem(state, claimed, options))
    },
    async deleteUnclaimed({ runId }) {
      return removeWhere(
        state.attemptCommands,
        (item) => item.payload.runId === runId,
      )
    },
  }
}
