import type { RunSnapshot, StoredNode, StoredRun } from './state.ts'
import { SELF_CHILD_KEY, TASK_RUN_NODE_NAME } from './child-key.ts'
import { isTerminalRunStatus } from './status.ts'

type Family = ReadonlyMap<string, RunSnapshot>

export type RetryParams = {
  readonly runId: string
  readonly expectedVersion: number
}

/** Validate the whole family before either adapter mutates any retry state. */
export function validateFailedRunRetry(
  snapshots: readonly RunSnapshot[],
  params: RetryParams,
): readonly RunSnapshot[] {
  const root = assertRetryableRoot(snapshots, params)
  const family: Family = new Map(
    snapshots.map((snapshot) => [snapshot.run.id, snapshot]),
  )

  for (const snapshot of snapshots) {
    assertLinkedToParent(snapshot, root, family)
    if (!isTerminalRunStatus(snapshot.run.status)) {
      throw new Error(`Run family [${root.id}] still has active work`)
    }
    assertTaskAttemptExists(snapshot)
    assertChildrenSettled(snapshot, family)
    assertMapChildrenComplete(snapshot)
  }

  return collectFrontier(root, family, snapshots)
}

function assertRetryableRoot(
  snapshots: readonly RunSnapshot[],
  params: RetryParams,
): StoredRun {
  const root = snapshots.find(({ run }) => run.id === params.runId)?.run
  if (!root) throw new Error(`Run [${params.runId}] not found`)
  if (root.parentRunId !== undefined) {
    throw new Error(`Run [${root.id}] is not a root run`)
  }
  if (root.status !== 'failed') {
    throw new Error(`Run [${root.id}] is not failed`)
  }
  if (root.version !== params.expectedVersion) {
    throw new Error(`Stale retry version for run [${root.id}]`)
  }
  if (root.rootRunId !== root.id) {
    throw new Error(`Conflicting root run [${root.id}]`)
  }
  return root
}

/** Every non-root member must be reachable from its parent's child records. */
function assertLinkedToParent(
  snapshot: RunSnapshot,
  root: StoredRun,
  family: Family,
) {
  const { run } = snapshot
  if (run.rootRunId !== root.id) {
    throw new Error(`Orphaned child run [${run.id}]`)
  }
  if (run.id === root.id) return

  const parent =
    run.parentRunId === undefined ? undefined : family.get(run.parentRunId)
  const linked = parent?.children.some(
    (child) =>
      child.childRunId === run.id && child.nodeName === run.parentNodeName,
  )
  if (!linked) throw new Error(`Orphaned child run [${run.id}]`)
}

function assertTaskAttemptExists(snapshot: RunSnapshot) {
  if (snapshot.run.kind !== 'task') return

  const attempted = snapshot.children.some(
    (child) =>
      child.nodeName === TASK_RUN_NODE_NAME &&
      child.childKey === SELF_CHILD_KEY &&
      child.attemptCount > 0,
  )
  if (!attempted) {
    throw new Error(`Missing task attempt [${snapshot.run.id}]`)
  }
}

/**
 * Each child must own a node, a consistent child run and a settled current
 * attempt — retry re-dispatches from exactly that frontier.
 */
function assertChildrenSettled(snapshot: RunSnapshot, family: Family) {
  const { run } = snapshot
  const nodesByName = indexNodes(snapshot)

  for (const child of snapshot.children) {
    if (!nodesByName.has(child.nodeName)) {
      throw new Error(`Missing node [${run.id}.${child.nodeName}]`)
    }

    if (child.childRunId !== undefined) {
      const nested = family.get(child.childRunId)?.run
      if (
        !nested ||
        nested.parentRunId !== run.id ||
        nested.parentNodeName !== child.nodeName
      ) {
        throw new Error(
          `Missing or conflicting child run [${child.childRunId}]`,
        )
      }
    }

    // A manual retry clears the current pointer, so a pending child accepts
    // its last attempt as the current one.
    const hasCurrent = snapshot.attempts.some(
      (attempt) =>
        (attempt.id === child.currentAttemptId ||
          (child.currentAttemptId === undefined &&
            child.status === 'pending')) &&
        attempt.childKey === child.childKey &&
        attempt.nodeName === child.nodeName &&
        attempt.attemptNumber === child.attemptCount,
    )
    if (child.attemptCount > 0 && !hasCurrent) {
      throw new Error(
        `Missing current attempt [${run.id}.${child.nodeName}.${child.childKey}]`,
      )
    }

    const latest = snapshot.attempts.find(
      (attempt) =>
        attempt.nodeName === child.nodeName &&
        attempt.childKey === child.childKey &&
        attempt.attemptNumber === child.attemptCount,
    )
    if (
      latest &&
      child.status !== 'completed' &&
      (latest.status === 'started' || latest.status === 'completed')
    ) {
      throw new Error(`Unsettled or conflicting attempt [${latest.id}]`)
    }
  }
}

/** A map node's children are its input items, one per index. */
function assertMapChildrenComplete(snapshot: RunSnapshot) {
  for (const node of snapshot.nodes) {
    if (node.kind !== 'mapTask' && node.kind !== 'mapWorkflow') continue
    if (!Array.isArray(node.input)) continue

    const children = snapshot.children.filter(
      (child) => child.nodeName === node.name,
    )
    if (
      children.length !== node.input.length ||
      children.some((child, index) => child.ordinal !== index)
    ) {
      throw new Error(
        `Incomplete map children [${snapshot.run.id}.${node.name}]`,
      )
    }
  }
}

/**
 * Completed aggregates are checkpoints too. Older settled-map runs can
 * contain failed descendants beneath one; those are outside this retry.
 */
function collectFrontier(
  root: StoredRun,
  family: Family,
  snapshots: readonly RunSnapshot[],
): readonly RunSnapshot[] {
  const frontier = new Set([root.id])

  for (const runId of frontier) {
    const snapshot = family.get(runId)!
    const nodesByName = indexNodes(snapshot)
    for (const child of snapshot.children) {
      if (child.status === 'completed' || !child.childRunId) continue
      if (nodesByName.get(child.nodeName)?.status === 'completed') continue
      if (family.get(child.childRunId)!.run.status !== 'completed') {
        frontier.add(child.childRunId)
      }
    }
  }

  return snapshots.filter(({ run }) => frontier.has(run.id))
}

function indexNodes(snapshot: RunSnapshot): ReadonlyMap<string, StoredNode> {
  return new Map(snapshot.nodes.map((node) => [node.name, node]))
}
