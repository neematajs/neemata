import type { ContinueRunCommand } from '../../runtime/commands.ts'
import type { RunCoordinationExecutor } from '../../runtime/executors.ts'
import type { Timestamp } from '../../types/index.ts'
import type { QueueItem } from './commands.ts'
import type { State } from './state.ts'
import {
  claimQueued,
  matchesClaim,
  queueItem,
  reclaimExpiredLeases,
  releaseQueueItem,
} from './commands.ts'

function earliestRunAt(
  left: Timestamp | undefined,
  right: Timestamp | undefined,
) {
  if (left === undefined || right === undefined) return undefined
  return left <= right ? left : right
}

function mergeContinueQueueItem(
  pending: QueueItem<ContinueRunCommand>,
  released: QueueItem<ContinueRunCommand>,
): QueueItem<ContinueRunCommand> {
  const lastError =
    released.deliveryCount > pending.deliveryCount
      ? released.lastError
      : pending.lastError
  const { lastError: _lastError, ...pendingWithoutError } = pending
  return {
    ...pendingWithoutError,
    runAt: earliestRunAt(pending.runAt, released.runAt),
    deliveryCount: Math.max(pending.deliveryCount, released.deliveryCount),
    ...(lastError === undefined ? {} : { lastError }),
  }
}

export function enqueueContinue(
  state: State,
  command: ContinueRunCommand,
  runAt?: Timestamp,
) {
  const { id, continueRunCommands, wake } = state

  // Dead items must not absorb fresh enqueues — a dead-lettered continue
  // command would otherwise silently swallow every later wake-up for its
  // run. Mirrors postgres, where claim-time dead rows keep their lease
  // token and therefore stay outside the continue-dedup partial index.
  const existingIndex = continueRunCommands.findIndex(
    (item) => item.deadAt === undefined && item.payload.runId === command.runId,
  )
  if (existingIndex === -1) {
    continueRunCommands.push(queueItem(state, id('continue'), command, runAt))
    if (runAt === undefined || runAt <= Date.now()) {
      wake.command('continue')
    }
    return
  }

  const existing = continueRunCommands[existingIndex]!
  continueRunCommands[existingIndex] = {
    ...existing,
    payload: command,
    runAt: earliestRunAt(existing.runAt, runAt),
  }
  if (runAt === undefined || runAt <= Date.now()) {
    wake.command('continue')
  }
}

export function requeueDeadContinue(state: State, commandId: string) {
  const { continueRunCommands } = state

  const deadIndex = continueRunCommands.findIndex(
    (item) => item.id === commandId && item.deadAt !== undefined,
  )
  if (deadIndex === -1) return false
  const dead = continueRunCommands[deadIndex]!
  const requeued: QueueItem<ContinueRunCommand> = {
    id: dead.id,
    payload: dead.payload,
    deliveryCount: 0,
    createdAt: dead.createdAt,
    sequence: dead.sequence,
  }
  const pendingIndex = continueRunCommands.findIndex(
    (item, index) =>
      index !== deadIndex &&
      item.deadAt === undefined &&
      item.payload.runId === dead.payload.runId,
  )
  if (pendingIndex === -1) {
    continueRunCommands[deadIndex] = requeued
    return true
  }

  // Requeue is another wake-up for the run, so an existing live command
  // absorbs it without reviving a duplicate stale payload.
  continueRunCommands[pendingIndex] = mergeContinueQueueItem(
    continueRunCommands[pendingIndex]!,
    requeued,
  )
  continueRunCommands.splice(deadIndex, 1)
  return true
}

export function createRunCoordinationExecutor(
  state: State,
): RunCoordinationExecutor {
  const { id, now, continueRunCommands, claimedContinueRunCommands } = state

  return {
    async enqueue(command) {
      enqueueContinue(state, command)
    },
    async enqueueDelayed(command, runAt) {
      enqueueContinue(state, command, runAt)
    },
    async claim(worker) {
      function eligible(command: ContinueRunCommand) {
        return worker.workflowNames.includes(command.workflowName)
      }
      reclaimExpiredLeases(
        state,
        claimedContinueRunCommands,
        continueRunCommands,
        eligible,
      )
      const date = now()
      const item = claimQueued(
        continueRunCommands,
        (queued) =>
          eligible(queued.payload) &&
          (queued.runAt === undefined || queued.runAt <= date),
      )
      if (!item) return null

      const claim = {
        id: item.id,
        command: item.payload,
        leaseToken: id('continue-lease'),
      }
      claimedContinueRunCommands.set(claim.id, {
        ...item,
        leaseToken: claim.leaseToken,
        leaseExpiresAt: date + worker.leaseMs,
      })
      return claim
    },
    async ack(command) {
      if (!matchesClaim(claimedContinueRunCommands.get(command.id), command)) {
        throw new Error('Stale workflow command ack')
      }
      claimedContinueRunCommands.delete(command.id)
    },
    async release(command, options) {
      const claimed = claimedContinueRunCommands.get(command.id)
      if (!claimed || !matchesClaim(claimed, command)) {
        return
      }

      claimedContinueRunCommands.delete(command.id)
      const released = releaseQueueItem(state, claimed, options)
      if (released.deadAt !== undefined) {
        continueRunCommands.push(released)
        return
      }

      const pendingIndex = continueRunCommands.findIndex(
        (item) =>
          item.deadAt === undefined &&
          item.payload.runId === released.payload.runId,
      )
      if (pendingIndex === -1) {
        continueRunCommands.push(released)
        return
      }

      continueRunCommands[pendingIndex] = mergeContinueQueueItem(
        continueRunCommands[pendingIndex]!,
        released,
      )
    },
  }
}
