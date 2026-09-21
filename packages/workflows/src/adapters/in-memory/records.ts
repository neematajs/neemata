import type {
  RunSnapshot,
  StoredAttempt,
  StoredNodeChild,
  StoredRun,
} from '../../runtime/state.ts'
import type { State } from './state.ts'

export function nodeKey(runId: string, nodeName: string) {
  return `${runId}:${nodeName}`
}

export function childKey(runId: string, nodeName: string, key: string) {
  return `${runId}:${nodeName}:${key}`
}

export function childRef(runId: string, nodeName: string, key: string) {
  return `${runId}.${nodeName}.${key}`
}

export function sortedChildren(rows: readonly StoredNodeChild[]) {
  return [...rows].sort((left, right) => {
    const byOrdinal = left.ordinal - right.ordinal
    if (byOrdinal !== 0) return byOrdinal
    return left.childKey.localeCompare(right.childKey)
  })
}

// Records created within one millisecond tie on their timestamp. These
// comparators leave ties alone: sorting is stable and the state's Maps iterate
// in insertion order, so ties keep creation order. Ids cannot break them, as
// `run-10` collates before `run-9`.
export function compareAttempts(left: StoredAttempt, right: StoredAttempt) {
  return left.dispatchedAt - right.dispatchedAt
}

export function compareRunsOldest(left: StoredRun, right: StoredRun) {
  return left.createdAt - right.createdAt
}

/** Newest first, including among ties: sorts oldest first and reverses. */
export function sortedRunsNewest(runs: readonly StoredRun[]) {
  return [...runs].sort(compareRunsOldest).reverse()
}

export function nodeChildren(state: State, runId: string, nodeName: string) {
  const { children } = state

  return [...children.values()].filter(
    (child) => child.runId === runId && child.nodeName === nodeName,
  )
}

export function runSnapshot(state: State, run: StoredRun): RunSnapshot {
  const nodes = Array.from(state.nodes.values()).filter(
    (node) => node.runId === run.id,
  )
  const children = Array.from(state.children.values()).filter(
    (child) => child.runId === run.id,
  )
  const attempts = Array.from(state.attempts.values()).filter(
    (attempt) => attempt.runId === run.id,
  )

  return { run, nodes, children, attempts }
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue)
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    )
    const sorted = new Map<string, unknown>()
    for (const [key, item] of entries) sorted.set(key, stableJsonValue(item))
    return Object.fromEntries(sorted)
  }
  return value
}

export function valueKey(value: unknown) {
  return JSON.stringify(stableJsonValue(value))
}

export function sameValue(left: unknown, right: unknown) {
  return valueKey(left) === valueKey(right)
}

export function sameOptionalValue(left: unknown, right: unknown) {
  return left === undefined && right === undefined
    ? true
    : left !== undefined && right !== undefined && sameValue(left, right)
}
