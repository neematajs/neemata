import type {
  RunSnapshot,
  StoredNodeChild,
  StoredRun,
} from '../../runtime/state.ts'
import type { WorkflowStore } from '../../runtime/store.ts'
import type { State } from './state.ts'
import { WorkflowRunConflictError } from '../../runtime/errors.ts'
import { validateFailedRunRetry } from '../../runtime/store.ts'
import { queueItem } from './commands.ts'
import { enqueueContinue } from './queue.ts'
import { childKey, nodeKey, runSnapshot, valueKey } from './records.ts'
import { createRetentionStore } from './retention.ts'
import { createChildStore } from './store-children.ts'
import { createCommandStore } from './store-commands.ts'
import { createChildAttempt, createNodeStore } from './store-nodes.ts'
import { createRunStore } from './store-runs.ts'

export function createStore(state: State): WorkflowStore {
  const {
    id,
    now,
    runs,
    nodes,
    attempts,
    children,
    activeUniqueRunKeys,
    allUniqueRunKeys,
    runLeases,
    continueRunCommands,
    attemptCommands,
    claimedContinueRunCommands,
    claimedAttemptCommands,
    wake,
  } = state

  return {
    async reopenFailedRun(params) {
      const snapshots: RunSnapshot[] = []
      for (const run of runs.values()) {
        if (run.rootRunId !== params.runId && run.id !== params.runId) continue
        const snapshot = runSnapshot(state, run)
        const children = [...snapshot.children].sort(
          (a, b) => a.ordinal - b.ordinal,
        )
        snapshots.push({ ...snapshot, children })
      }
      const reopening = validateFailedRunRetry(snapshots, params)
      for (const { run } of reopening) {
        const lease = runLeases.get(run.id)
        if (lease && lease.expiresAt > new Date()) {
          throw new Error(`Run [${run.id}] is busy`)
        }
        if (
          [
            ...claimedAttemptCommands.values(),
            ...claimedContinueRunCommands.values(),
          ].some(
            (claim) =>
              claim.payload.runId === run.id &&
              claim.leaseExpiresAt > new Date(),
          )
        ) {
          throw new Error(`Run [${run.id}] has an active attempt`)
        }
        if (!run.unique) continue
        const keys =
          run.unique.scope === 'active' ? activeUniqueRunKeys : allUniqueRunKeys
        const holder = keys.get(valueKey(run.unique.key))
        if (holder && holder !== run.id) {
          throw new WorkflowRunConflictError({
            runId: holder,
            status: runs.get(holder)!.status,
            key: run.unique.key,
            scope: run.unique.scope,
          })
        }
      }
      // No await between validation, reopening and enqueue: observers only see
      // the committed family, and duplicate retries cannot interleave.
      const date = now()
      for (const snapshot of reopening) {
        const run = snapshot.run
        const updated: StoredRun = {
          ...run,
          status: 'queued',
          error: undefined,
          output: undefined,
          activeSince: date,
          updatedAt: date,
          version: run.version + 1,
        }
        runs.set(run.id, updated)
        runLeases.delete(run.id)
        for (const queue of [continueRunCommands, attemptCommands]) {
          for (let index = queue.length - 1; index >= 0; index--) {
            const item = queue[index]!
            if (item.payload.runId !== run.id) continue
            if (item.deadAt) {
              queue[index] = { ...item, reapedAt: date }
            } else {
              queue.splice(index, 1)
            }
          }
        }
        for (const [key, claim] of claimedAttemptCommands) {
          if (claim.payload.runId === run.id) claimedAttemptCommands.delete(key)
        }
        for (const [key, claim] of claimedContinueRunCommands) {
          if (claim.payload.runId === run.id) {
            claimedContinueRunCommands.delete(key)
          }
        }
        if (run.unique) {
          const keys =
            run.unique.scope === 'active'
              ? activeUniqueRunKeys
              : allUniqueRunKeys
          keys.set(valueKey(run.unique.key), run.id)
        }
        for (const node of snapshot.nodes) {
          if (node.status === 'completed') continue
          nodes.set(nodeKey(run.id, node.name), {
            ...node,
            status: 'pending',
            error: undefined,
            output: undefined,
            updatedAt: date,
            version: node.version + 1,
          })
        }
        for (const child of snapshot.children) {
          if (child.status === 'completed') continue
          if (
            snapshot.nodes.find((node) => node.name === child.nodeName)
              ?.status === 'completed'
          ) {
            continue
          }
          const reopened: StoredNodeChild = {
            ...child,
            currentAttemptId: undefined,
            status: 'pending',
            error: undefined,
            output: undefined,
            updatedAt: date,
            version: child.version + 1,
          }
          children.set(
            childKey(run.id, child.nodeName, child.childKey),
            reopened,
          )
        }
        wake.runStatus(updated)
      }
      const root = runs.get(params.runId)!
      if (root.kind === 'task') {
        const child = children.get(childKey(root.id, '$task', '$self'))!
        const previous = [...attempts.values()].find(
          (attempt) =>
            attempt.runId === root.id &&
            attempt.nodeName === child.nodeName &&
            attempt.childKey === child.childKey &&
            attempt.attemptNumber === child.attemptCount,
        )!
        const attempt = createChildAttempt(
          state,
          child,
          previous.input,
          previous.idempotencyKey,
        )
        attemptCommands.push(
          queueItem(state, id('task'), {
            kind: 'taskAttempt',
            runId: root.id,
            workflowName: root.workflowName,
            taskName: root.taskName ?? root.name,
            nodeName: '$task',
            childKey: child.childKey,
            attemptId: attempt.id,
            leaseToken: attempt.leaseToken!,
            input: attempt.input,
            idempotencyKey: attempt.idempotencyKey,
          }),
        )
        wake.command('task')
      } else {
        enqueueContinue(state, {
          kind: 'continueRun',
          runId: root.id,
          workflowName: root.workflowName,
        })
      }
      return root
    },
    ...createRunStore(state),
    ...createNodeStore(state),
    ...createChildStore(state),
    ...createCommandStore(state),
    ...createRetentionStore(state),
  }
}
