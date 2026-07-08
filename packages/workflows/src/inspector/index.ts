import type {
  RunSnapshot,
  StoredAttempt,
  StoredNode,
  StoredNodeChild,
  StoredRun,
  StoredRunEvent,
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
  MapRunMode,
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
  /** Fan-out completion mode for mapTask and mapWorkflow nodes. */
  readonly mode?: MapRunMode
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

function presentationMetadata(input: {
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

function serializeWorkflowGraphTarget(
  kind: WorkflowGraphTarget['kind'],
  target: AnyTaskDefinition | AnyWorkflowDefinition,
): WorkflowGraphTarget {
  return {
    kind,
    name: target.name,
    ...presentationMetadata(target),
  }
}

export function serializeWorkflowGraph(
  definition: AnyWorkflowDefinition,
): WorkflowGraph {
  return {
    name: definition.name,
    ...presentationMetadata(definition),
    nodes: definition.nodes.map((node): WorkflowGraphNode => {
      switch (node.kind) {
        case 'activity':
          return {
            name: node.name,
            kind: node.kind,
            ...presentationMetadata(node),
          }
        case 'task':
          return {
            name: node.name,
            kind: node.kind,
            ...presentationMetadata(node),
            target: serializeWorkflowGraphTarget('task', node.task),
          }
        case 'workflow':
          return {
            name: node.name,
            kind: node.kind,
            ...presentationMetadata(node),
            target: serializeWorkflowGraphTarget('workflow', node.workflow),
          }
        case 'branch':
        case 'parallel':
          return {
            name: node.name,
            kind: node.kind,
            ...presentationMetadata(node),
            cases: Object.entries(node.cases).map(
              ([key, branchCase]): WorkflowGraphCase => {
                const base = {
                  key,
                  kind: branchCase.kind,
                  ...presentationMetadata(branchCase),
                }
                if (branchCase.kind === 'activity') return base

                // BranchCaseDefinition's conditional payload doesn't narrow on
                // `kind` at the union default, so the cast lives here once.
                const target = (
                  branchCase as unknown as {
                    target: AnyTaskDefinition | AnyWorkflowDefinition
                  }
                ).target
                return {
                  ...base,
                  target: serializeWorkflowGraphTarget(branchCase.kind, target),
                }
              },
            ),
          }
        case 'mapTask':
          return {
            name: node.name,
            kind: node.kind,
            ...presentationMetadata(node),
            target: serializeWorkflowGraphTarget('task', node.task),
            mode: node.mode,
          }
        case 'mapWorkflow':
          return {
            name: node.name,
            kind: node.kind,
            ...presentationMetadata(node),
            target: serializeWorkflowGraphTarget('workflow', node.workflow),
            mode: node.mode,
          }
      }
    }),
  }
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
  return {
    workflows: Array.from(input.workflows ?? [], serializeWorkflowGraph),
    tasks: Array.from(input.tasks ?? [], (task) => ({
      name: task.name,
      ...presentationMetadata(task),
    })),
  }
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
export type RunEventDto = WireSafe<StoredRunEvent>

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

export function toRunDto(run: StoredRun): RunDto {
  return convertDates(run, { createdAt: true, updatedAt: true })
}

export function toNodeDto(node: StoredNode): NodeDto {
  return convertDates(node, { createdAt: true, updatedAt: true })
}

export function toNodeChildDto(child: StoredNodeChild): NodeChildDto {
  return convertDates(child, { createdAt: true, updatedAt: true })
}

export function toAttemptDto(attempt: StoredAttempt): AttemptDto {
  return convertDates(attempt, {
    dispatchedAt: true,
    heartbeatAt: true,
    completedAt: true,
  })
}

export function toRunEventDto(event: StoredRunEvent): RunEventDto {
  return convertDates(event, { createdAt: true })
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
  const attemptsByChildKey = new Map<string, AttemptSummary[]>()
  for (const attempt of detail.attempts) {
    if (attempt.nodeName !== nodeName) continue
    const group = attemptsByChildKey.get(attempt.childKey) ?? []
    group.push(attempt)
    attemptsByChildKey.set(attempt.childKey, group)
  }
  for (const group of attemptsByChildKey.values()) {
    group.sort((left, right) => left.attemptNumber - right.attemptNumber)
  }

  return detail.children
    .filter((child) => child.nodeName === nodeName)
    .sort((left, right) => {
      const byOrdinal = left.ordinal - right.ordinal
      if (byOrdinal !== 0) return byOrdinal
      return left.childKey.localeCompare(right.childKey)
    })
    .map((child) => {
      const parsed = parseChildKey(child.childKey)
      const childRun =
        child.childRunId === undefined
          ? undefined
          : childRuns.get(child.childRunId)
      return {
        key: child.childKey,
        ...(parsed === undefined ? {} : { parsed }),
        child,
        attempts: attemptsByChildKey.get(child.childKey) ?? [],
        ...(childRun === undefined ? {} : { childRun }),
      }
    })
}

export function toRunSummaryDto(summary: RunSummary): RunSummaryDto {
  return convertDates(summary, { createdAt: true, updatedAt: true })
}

function toNodeSummaryDto(summary: NodeSummary): NodeSummaryDto {
  return convertDates(summary, { createdAt: true, updatedAt: true })
}

function toNodeChildSummaryDto(summary: NodeChildSummary): NodeChildSummaryDto {
  return convertDates(summary, { createdAt: true, updatedAt: true })
}

function toAttemptSummaryDto(summary: AttemptSummary): AttemptSummaryDto {
  return convertDates(summary, {
    dispatchedAt: true,
    heartbeatAt: true,
    completedAt: true,
  })
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
