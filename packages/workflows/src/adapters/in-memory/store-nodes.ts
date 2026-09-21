import type { ClaimedAttempt } from '../../runtime/commands.ts'
import type {
  StoredAttempt,
  StoredNode,
  StoredNodeChild,
  StoredRun,
} from '../../runtime/state.ts'
import type {
  CreateAttemptInput,
  CreateNodeInput,
  WorkflowStore,
} from '../../runtime/store.ts'
import type { State } from './state.ts'
import { toStoredError } from '../../runtime/errors.ts'
import {
  isTerminalNodeStatus,
  isTerminalRunStatus,
} from '../../runtime/status.ts'
import {
  NODE_TRANSITIONS,
  RUN_TRANSITIONS,
  canTransition,
} from '../../runtime/transitions.ts'
import { matchesClaim } from './commands.ts'
import {
  childKey,
  childRef,
  compareAttempts,
  nodeChildren,
  nodeKey,
  sortedChildren,
} from './records.ts'
import { releaseActiveUniqueKey } from './store-runs.ts'

export function createChildAttempt(
  state: State,
  child: StoredNodeChild,
  input: unknown,
  idempotencyKey: readonly unknown[] | undefined,
): StoredAttempt {
  const { id, now, nodes, attempts, children, wake } = state

  const attempt: StoredAttempt = {
    id: id('attempt'),
    runId: child.runId,
    nodeName: child.nodeName,
    childKey: child.childKey,
    status: 'started',
    leaseToken: id('attempt-lease'),
    attemptNumber: child.attemptCount + 1,
    retryAttemptNumber:
      (child.currentAttemptId
        ? attempts.get(child.currentAttemptId)!.retryAttemptNumber
        : 0) + 1,
    input,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    dispatchedAt: now(),
  }
  attempts.set(attempt.id, attempt)
  wake.statusChange(undefined, attempt)
  const updatedChild: StoredNodeChild = {
    ...child,
    status: 'running',
    currentAttemptId: attempt.id,
    attemptCount: child.attemptCount + 1,
    version: child.version + 1,
    updatedAt: now(),
  }
  children.set(
    childKey(child.runId, child.nodeName, child.childKey),
    updatedChild,
  )
  wake.statusChange(child, updatedChild)

  // Aggregate hint only: the node mirrors "some child is executing" so
  // observers see progress without deriving it from child rows.
  const key = nodeKey(child.runId, child.nodeName)
  const node = nodes.get(key)
  // Self-inclusive like the postgres guard, so version bumps stay in
  // lockstep across adapters even when the node is already running.
  if (
    node &&
    (node.status === 'running' ||
      canTransition(NODE_TRANSITIONS, node.status, 'running'))
  ) {
    const updatedNode: StoredNode = {
      ...node,
      status: 'running',
      version: node.version + 1,
      updatedAt: now(),
    }
    nodes.set(key, updatedNode)
    wake.statusChange(node, updatedNode)
  }
  return attempt
}

function fencedCurrentAttempt(
  state: State,
  attemptId: string,
  leaseToken: string,
  claim: ClaimedAttempt | undefined,
):
  | { readonly attempt: StoredAttempt; readonly child: StoredNodeChild }
  | undefined {
  const { attempts, children, claimedAttemptCommands } = state

  // The attempt's own token never rotates, so only the queue claim tells a
  // worker that was taken over from the new claimant.
  if (claim && !matchesClaim(claimedAttemptCommands.get(claim.id), claim)) {
    return undefined
  }

  const attempt = attempts.get(attemptId)
  if (!attempt || attempt.leaseToken !== leaseToken) return undefined
  if (attempt.status !== 'started') return undefined

  const child = children.get(
    childKey(attempt.runId, attempt.nodeName, attempt.childKey),
  )
  if (
    !child ||
    isTerminalNodeStatus(child.status) ||
    child.currentAttemptId !== attemptId
  ) {
    return undefined
  }
  return { attempt, child }
}

type NodeStore = Pick<
  WorkflowStore,
  | 'loadNodeSnapshot'
  | 'createNode'
  | 'setNodeInput'
  | 'createAttempt'
  | 'completeCurrentAttempt'
  | 'failCurrentAttempt'
  | 'timeoutCurrentAttempt'
  | 'completeNode'
  | 'failNode'
  | 'markRunRunning'
  | 'markRunWaiting'
  | 'completeRun'
  | 'failRun'
  | 'requestRunCancellation'
  | 'cancelRun'
  | 'cancelNode'
  | 'cancelNonTerminalRunNodes'
>

/**
 * With a `claim`, attempt settlement also requires that claim to still be the
 * queue item's; without one (reaping, dispatch failure) it stays unfenced.
 */
export function createNodeStore(
  state: State,
  claim?: ClaimedAttempt,
): NodeStore {
  const { now, runs, nodes, attempts, children, wake } = state

  return {
    async loadNodeSnapshot({ runId, nodeName }) {
      const node = nodes.get(nodeKey(runId, nodeName))
      if (!node) return undefined

      return {
        node,
        children: sortedChildren(nodeChildren(state, runId, nodeName)),
        attempts: [...attempts.values()]
          .filter(
            (attempt) =>
              attempt.runId === runId && attempt.nodeName === nodeName,
          )
          .sort(compareAttempts),
      }
    },

    async createNode(input: CreateNodeInput) {
      const key = nodeKey(input.runId, input.name)
      const existing = nodes.get(key)
      if (existing) return existing

      const date = now()
      const node: StoredNode = {
        runId: input.runId,
        name: input.name,
        kind: input.kind,
        status: 'pending',
        version: 1,
        createdAt: date,
        updatedAt: date,
      }
      nodes.set(key, node)
      return node
    },

    async setNodeInput({ runId, nodeName, input }) {
      const key = nodeKey(runId, nodeName)
      const node = nodes.get(key)
      if (!node) throw new Error(`Missing node [${runId}.${nodeName}]`)
      if (isTerminalNodeStatus(node.status)) return node

      const updated: StoredNode = {
        ...node,
        input,
        version: node.version + 1,
        updatedAt: now(),
      }
      nodes.set(key, updated)
      return updated
    },

    async createAttempt(input: CreateAttemptInput) {
      const child = children.get(
        childKey(input.runId, input.nodeName, input.childKey),
      )
      if (!child) {
        throw new Error(
          `Missing node child [${childRef(input.runId, input.nodeName, input.childKey)}]`,
        )
      }
      if (isTerminalNodeStatus(child.status)) {
        throw new Error(
          `Terminal node child [${childRef(input.runId, input.nodeName, input.childKey)}] cannot create attempt`,
        )
      }

      return createChildAttempt(state, child, input.input, input.idempotencyKey)
    },

    async completeCurrentAttempt({ attemptId, leaseToken, output }) {
      const fenced = fencedCurrentAttempt(state, attemptId, leaseToken, claim)
      if (!fenced) return undefined

      const { attempt, child } = fenced
      const updated: StoredAttempt = {
        ...attempt,
        status: 'completed',
        output,
        completedAt: now(),
      }
      attempts.set(attemptId, updated)
      wake.statusChange(attempt, updated)
      const completedChild: StoredNodeChild = {
        ...child,
        status: 'completed',
        output,
        version: child.version + 1,
        updatedAt: now(),
      }
      children.set(
        childKey(child.runId, child.nodeName, child.childKey),
        completedChild,
      )
      wake.statusChange(child, completedChild)
      return updated
    },

    async failCurrentAttempt({ attemptId, leaseToken, error }) {
      const fenced = fencedCurrentAttempt(state, attemptId, leaseToken, claim)
      if (!fenced) return undefined

      const updated: StoredAttempt = {
        ...fenced.attempt,
        status: 'failed',
        error: toStoredError(error),
        completedAt: now(),
      }
      attempts.set(attemptId, updated)
      wake.statusChange(fenced.attempt, updated)
      return updated
    },

    async timeoutCurrentAttempt({ attemptId, leaseToken, error }) {
      const fenced = fencedCurrentAttempt(state, attemptId, leaseToken, claim)
      if (!fenced) return undefined

      const updated: StoredAttempt = {
        ...fenced.attempt,
        status: 'timedOut',
        error: toStoredError(error),
        completedAt: now(),
      }
      attempts.set(attemptId, updated)
      wake.statusChange(fenced.attempt, updated)
      return updated
    },

    async completeNode({ runId, nodeName, output }) {
      const key = nodeKey(runId, nodeName)
      const node = nodes.get(key)
      if (!node) return undefined
      if (isTerminalNodeStatus(node.status)) return node

      const updated: StoredNode = {
        ...node,
        status: 'completed',
        output,
        version: node.version + 1,
        updatedAt: now(),
      }
      nodes.set(key, updated)
      wake.statusChange(node, updated)
      return updated
    },

    async failNode({ runId, nodeName, error }) {
      const key = nodeKey(runId, nodeName)
      const node = nodes.get(key)
      if (!node) return undefined
      if (isTerminalNodeStatus(node.status)) return node

      const updated: StoredNode = {
        ...node,
        status: 'failed',
        error: toStoredError(error),
        version: node.version + 1,
        updatedAt: now(),
      }
      nodes.set(key, updated)
      wake.statusChange(node, updated)
      return updated
    },

    async markRunRunning({ runId }) {
      const run = runs.get(runId)
      if (!run) return undefined
      if (!canTransition(RUN_TRANSITIONS, run.status, 'running')) return run

      const updated: StoredRun = {
        ...run,
        status: 'running',
        version: run.version + 1,
        updatedAt: now(),
      }
      runs.set(runId, updated)
      wake.runStatus(updated)
      return updated
    },

    async markRunWaiting({ runId }) {
      const run = runs.get(runId)
      if (!run) return undefined
      if (!canTransition(RUN_TRANSITIONS, run.status, 'waiting')) return run

      const updated: StoredRun = {
        ...run,
        status: 'waiting',
        version: run.version + 1,
        updatedAt: now(),
      }
      runs.set(runId, updated)
      wake.runStatus(updated)
      return updated
    },

    async completeRun({ runId, output }) {
      const run = runs.get(runId)
      if (!run) return undefined
      if (isTerminalRunStatus(run.status)) return run

      const updated: StoredRun = {
        ...run,
        status: 'completed',
        output,
        version: run.version + 1,
        updatedAt: now(),
      }
      runs.set(runId, updated)
      releaseActiveUniqueKey(state, updated)
      wake.runStatus(updated)
      return updated
    },

    async failRun({ runId, error }) {
      const run = runs.get(runId)
      if (!run) return undefined
      if (isTerminalRunStatus(run.status)) return run

      const updated: StoredRun = {
        ...run,
        status: 'failed',
        error: toStoredError(error),
        version: run.version + 1,
        updatedAt: now(),
      }
      runs.set(runId, updated)
      releaseActiveUniqueKey(state, updated)
      wake.runStatus(updated)
      return updated
    },

    async requestRunCancellation({ runId }) {
      const run = runs.get(runId)
      if (!run) return undefined
      if (isTerminalRunStatus(run.status) || run.status === 'cancelling') {
        return run
      }

      const updated: StoredRun = {
        ...run,
        status: 'cancelling',
        version: run.version + 1,
        updatedAt: now(),
      }
      runs.set(runId, updated)
      wake.runStatus(updated)
      wake.cancellation(runId)
      return updated
    },

    async cancelRun({ runId }) {
      const run = runs.get(runId)
      if (!run) return undefined
      if (isTerminalRunStatus(run.status)) return run

      const updated: StoredRun = {
        ...run,
        status: 'cancelled',
        version: run.version + 1,
        updatedAt: now(),
      }
      runs.set(runId, updated)
      releaseActiveUniqueKey(state, updated)
      wake.runStatus(updated)
      return updated
    },

    async cancelNode({ runId, nodeName }) {
      const key = nodeKey(runId, nodeName)
      const node = nodes.get(key)
      if (!node) return undefined
      if (isTerminalNodeStatus(node.status)) return node

      const updated: StoredNode = {
        ...node,
        status: 'cancelled',
        version: node.version + 1,
        updatedAt: now(),
      }
      nodes.set(key, updated)
      wake.statusChange(node, updated)
      return updated
    },

    async cancelNonTerminalRunNodes({ runId }) {
      const updated: StoredNode[] = []
      for (const node of Array.from(nodes.values())) {
        if (node.runId !== runId || isTerminalNodeStatus(node.status)) continue
        const cancelled: StoredNode = {
          ...node,
          status: 'cancelled',
          version: node.version + 1,
          updatedAt: now(),
        }
        nodes.set(nodeKey(node.runId, node.name), cancelled)
        wake.statusChange(node, cancelled)
        updated.push(cancelled)
      }
      for (const child of Array.from(children.values())) {
        if (child.runId !== runId || isTerminalNodeStatus(child.status)) {
          continue
        }
        const cancelled: StoredNodeChild = {
          ...child,
          status: 'cancelled',
          version: child.version + 1,
          updatedAt: now(),
        }
        children.set(
          childKey(child.runId, child.nodeName, child.childKey),
          cancelled,
        )
        wake.statusChange(child, cancelled)
      }
      for (const attempt of Array.from(attempts.values())) {
        if (attempt.runId !== runId || attempt.status !== 'started') continue
        const cancelled: StoredAttempt = {
          ...attempt,
          status: 'cancelled',
          completedAt: now(),
        }
        attempts.set(attempt.id, cancelled)
        wake.statusChange(attempt, cancelled)
      }
      return updated
    },
  }
}
