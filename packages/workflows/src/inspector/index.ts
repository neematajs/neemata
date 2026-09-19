import type {
  RunSnapshot,
  StoredAttempt,
  StoredNode,
  StoredNodeChild,
  StoredRun,
} from '../runtime/state.ts'
import type {
  AttemptSummary,
  NodeChildSummary,
  NodeSnapshot,
  NodeSummary,
  RunDetail,
  RunFamilyEntry,
  RunSummary,
} from '../runtime/store.ts'
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  BranchCaseKind,
  WorkflowNodeKind,
} from '../types/index.ts'
import { parseChildKey, type ParsedChildKey } from '../runtime/child-key.ts'

/**
 * Canonical JSON shape of a workflow definition's topology. Stable by
 * design: it doubles as the per-run definition-snapshot format, so UIs can
 * render historical runs against the graph they actually executed.
 */
export type WorkflowGraph = {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly nodes: readonly WorkflowGraphNode[]
}

export type WorkflowGraphNode = {
  readonly name: string
  readonly kind: WorkflowNodeKind
  readonly title?: string
  readonly description?: string
  /** Referenced task/workflow for task, workflow, mapTask and mapWorkflow nodes. */
  readonly target?: WorkflowGraphTarget
  /** Branch and parallel members, in definition order. */
  readonly cases?: readonly WorkflowGraphCase[]
}

export type WorkflowGraphTarget = {
  readonly kind: 'task' | 'workflow'
  readonly name: string
  readonly title?: string
  readonly description?: string
}

export type WorkflowGraphCase = {
  readonly key: string
  readonly kind: BranchCaseKind
  readonly title?: string
  readonly description?: string
  /** Absent for inline activity cases — they have no named target. */
  readonly target?: WorkflowGraphTarget
}

function metadata(input: {
  readonly title?: string
  readonly description?: string
}) {
  return {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
  }
}

function serializeTarget(
  kind: WorkflowGraphTarget['kind'],
  target: AnyTaskDefinition | AnyWorkflowDefinition,
): WorkflowGraphTarget {
  return {
    kind,
    name: target.name,
    ...metadata(target),
  }
}

export function serializeWorkflowGraph(
  definition: AnyWorkflowDefinition,
): WorkflowGraph {
  const nodes = definition.nodes.map((node): WorkflowGraphNode => {
    const base = { name: node.name, kind: node.kind, ...metadata(node) }

    switch (node.kind) {
      case 'activity':
        return base
      case 'task':
      case 'mapTask':
        return { ...base, target: serializeTarget('task', node.task) }
      case 'workflow':
      case 'mapWorkflow':
        return { ...base, target: serializeTarget('workflow', node.workflow) }
      case 'branch':
      case 'parallel': {
        const cases: WorkflowGraphCase[] = []

        for (const [key, branchCase] of Object.entries(node.cases)) {
          const graphCase = {
            key,
            kind: branchCase.kind,
            ...metadata(branchCase),
          }
          if (branchCase.kind === 'activity') {
            cases.push(graphCase)
            continue
          }

          const target = serializeTarget(branchCase.kind, branchCase.target)
          cases.push({ ...graphCase, target })
        }

        return { ...base, cases }
      }
    }
  })

  return { name: definition.name, ...metadata(definition), nodes }
}

export type WorkflowCatalog = {
  readonly workflows: readonly WorkflowGraph[]
  readonly tasks: readonly WorkflowCatalogTask[]
}

export type WorkflowCatalogTask = {
  readonly name: string
  readonly title?: string
  readonly description?: string
}

/**
 * "What exists and what does it look like" for a set of definitions. Takes
 * plain definitions so any holder of them (app code, a runtime registry) can
 * produce the catalog without coupling to runtime internals.
 */
export function serializeWorkflowCatalog(input: {
  readonly workflows?: Iterable<AnyWorkflowDefinition>
  readonly tasks?: Iterable<AnyTaskDefinition>
}): WorkflowCatalog {
  const workflows = Array.from(input.workflows ?? [], serializeWorkflowGraph)
  const tasks = Array.from(input.tasks ?? [], (task) => ({
    name: task.name,
    ...metadata(task),
  }))

  return { workflows, tasks }
}

/**
 * Wire-safe counterpart of a stored type: `Date` fields become ISO-8601
 * strings so the value survives JSON transport unchanged. Applies to the
 * envelope only — payload fields (`input`/`output`/`item`/`error` contents)
 * are stored JSON values passed through untouched; encoding payload `Date`s
 * is the schema layer's concern, and persisted payloads have already been
 * through JSON in any real adapter.
 */
export type WireSafe<T> = {
  [K in keyof T]: T[K] extends Date
    ? string
    : T[K] extends Date | undefined
      ? string | undefined
      : T[K]
}

type DateKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends Date ? K : never
}[keyof T]

// Requiring every Date key at the type level makes adding a Date field to a
// stored type a compile error here instead of a silent Date leaking through
// a DTO typed as string.
function convertDates<T extends object>(
  value: T,
  dateKeys: Record<DateKeys<T>, true>,
): WireSafe<T> {
  const next = { ...value } as Record<string, unknown>
  for (const key of Object.keys(dateKeys)) {
    const current = next[key]
    if (current instanceof Date) next[key] = current.toISOString()
  }
  return next as WireSafe<T>
}

export type RunDto = WireSafe<StoredRun>
export type NodeDto = WireSafe<StoredNode>
export type NodeChildDto = WireSafe<StoredNodeChild>
export type AttemptDto = WireSafe<StoredAttempt>

export type RunSnapshotDto = {
  readonly run: RunDto
  readonly nodes: readonly NodeDto[]
  readonly children: readonly NodeChildDto[]
  readonly attempts: readonly AttemptDto[]
}

export type NodeUnit = {
  readonly key: string
  readonly parsed?: ParsedChildKey
  readonly child: NodeChildSummary
  readonly attempts: readonly AttemptSummary[]
  readonly childRun?: RunSummary
}

export type RunSummaryDto = WireSafe<RunSummary>
export type NodeSummaryDto = WireSafe<NodeSummary>
export type NodeChildSummaryDto = WireSafe<NodeChildSummary>
export type AttemptSummaryDto = WireSafe<AttemptSummary>

export type RunDetailDto = {
  readonly run: RunSummaryDto
  readonly nodes: readonly NodeSummaryDto[]
  readonly children: readonly NodeChildSummaryDto[]
  readonly attempts: readonly AttemptSummaryDto[]
  readonly childRuns: readonly RunSummaryDto[]
}

export type NodeSnapshotDto = {
  readonly node: NodeDto
  readonly children: readonly NodeChildDto[]
  readonly attempts: readonly AttemptDto[]
}

export type RunFamilyEntryDto = {
  readonly run: RunSummaryDto
  readonly origin?: RunFamilyEntry['origin']
}

export type NodeUnitDto = {
  readonly key: string
  readonly parsed?: ParsedChildKey
  readonly child: NodeChildSummaryDto
  readonly attempts: readonly AttemptSummaryDto[]
  readonly childRun?: RunSummaryDto
}

const runDates = {
  activeSince: true,
  createdAt: true,
  updatedAt: true,
} as const
const recordDates = { createdAt: true, updatedAt: true } as const
const attemptDates = {
  dispatchedAt: true,
  heartbeatAt: true,
  completedAt: true,
} as const

export function toRunDto(run: StoredRun): RunDto {
  return convertDates(run, runDates)
}

export function toNodeDto(node: StoredNode): NodeDto {
  return convertDates(node, recordDates)
}

export function toNodeChildDto(child: StoredNodeChild): NodeChildDto {
  return convertDates(child, recordDates)
}

export function toAttemptDto(attempt: StoredAttempt): AttemptDto {
  return convertDates(attempt, attemptDates)
}

export function toRunSnapshotDto(snapshot: RunSnapshot): RunSnapshotDto {
  return {
    run: toRunDto(snapshot.run),
    nodes: snapshot.nodes.map(toNodeDto),
    children: snapshot.children.map(toNodeChildDto),
    attempts: snapshot.attempts.map(toAttemptDto),
  }
}

export function nodeUnits(
  detail: RunDetail,
  nodeName: string,
): readonly NodeUnit[] {
  const childRuns = new Map(detail.childRuns.map((run) => [run.id, run]))
  const byChild = new Map<string, AttemptSummary[]>()
  for (const attempt of detail.attempts) {
    if (attempt.nodeName !== nodeName) continue
    const group = byChild.get(attempt.childKey) ?? []
    group.push(attempt)
    byChild.set(attempt.childKey, group)
  }
  for (const group of byChild.values()) {
    group.sort((left, right) => left.attemptNumber - right.attemptNumber)
  }

  const children = detail.children.filter(
    (child) => child.nodeName === nodeName,
  )
  children.sort((left, right) => {
    const byOrdinal = left.ordinal - right.ordinal
    if (byOrdinal !== 0) return byOrdinal
    return left.childKey.localeCompare(right.childKey)
  })

  return children.map((child) => {
    const parsed = parseChildKey(child.childKey)
    const childRun =
      child.childRunId === undefined
        ? undefined
        : childRuns.get(child.childRunId)
    const attempts = byChild.get(child.childKey) ?? []
    return {
      key: child.childKey,
      ...(parsed === undefined ? {} : { parsed }),
      child,
      attempts,
      ...(childRun === undefined ? {} : { childRun }),
    }
  })
}

export function toRunSummaryDto(summary: RunSummary): RunSummaryDto {
  return convertDates(summary, runDates)
}

function toNodeSummaryDto(summary: NodeSummary): NodeSummaryDto {
  return convertDates(summary, recordDates)
}

function toNodeChildSummaryDto(summary: NodeChildSummary): NodeChildSummaryDto {
  return convertDates(summary, recordDates)
}

function toAttemptSummaryDto(summary: AttemptSummary): AttemptSummaryDto {
  return convertDates(summary, attemptDates)
}

export function toRunDetailDto(detail: RunDetail): RunDetailDto {
  return {
    run: toRunSummaryDto(detail.run),
    nodes: detail.nodes.map(toNodeSummaryDto),
    children: detail.children.map(toNodeChildSummaryDto),
    attempts: detail.attempts.map(toAttemptSummaryDto),
    childRuns: detail.childRuns.map(toRunSummaryDto),
  }
}

export function toNodeSnapshotDto(snapshot: NodeSnapshot): NodeSnapshotDto {
  return {
    node: toNodeDto(snapshot.node),
    children: snapshot.children.map(toNodeChildDto),
    attempts: snapshot.attempts.map(toAttemptDto),
  }
}

export function toRunFamilyEntryDto(entry: RunFamilyEntry): RunFamilyEntryDto {
  return {
    run: toRunSummaryDto(entry.run),
    ...(entry.origin === undefined ? {} : { origin: entry.origin }),
  }
}

export function toNodeUnitDto(unit: NodeUnit): NodeUnitDto {
  return {
    key: unit.key,
    ...(unit.parsed === undefined ? {} : { parsed: unit.parsed }),
    child: toNodeChildSummaryDto(unit.child),
    attempts: unit.attempts.map(toAttemptSummaryDto),
    ...(unit.childRun === undefined
      ? {}
      : { childRun: toRunSummaryDto(unit.childRun) }),
  }
}
