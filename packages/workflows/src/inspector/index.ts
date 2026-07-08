import type {
  RunSnapshot,
  StoredAttempt,
  StoredNode,
  StoredNodeChild,
  StoredRun,
} from '../runtime/state.ts'
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  BranchCaseKind,
  MapRunMode,
  WorkflowNodeKind,
} from '../types/index.ts'

/**
 * Canonical JSON shape of a workflow definition's topology. Stable by
 * design: it doubles as the per-run definition-snapshot format, so UIs can
 * render historical runs against the graph they actually executed.
 */
export type WorkflowGraph = {
  readonly name: string
  readonly nodes: readonly WorkflowGraphNode[]
}

export type WorkflowGraphNode = {
  readonly name: string
  readonly kind: WorkflowNodeKind
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
}

export type WorkflowGraphCase = {
  readonly key: string
  readonly kind: BranchCaseKind
  /** Absent for inline activity cases — they have no named target. */
  readonly target?: WorkflowGraphTarget
}

export function serializeWorkflowGraph(
  definition: AnyWorkflowDefinition,
): WorkflowGraph {
  return {
    name: definition.name,
    nodes: definition.nodes.map((node): WorkflowGraphNode => {
      switch (node.kind) {
        case 'activity':
          return { name: node.name, kind: node.kind }
        case 'task':
          return {
            name: node.name,
            kind: node.kind,
            target: { kind: 'task', name: node.task.name },
          }
        case 'workflow':
          return {
            name: node.name,
            kind: node.kind,
            target: { kind: 'workflow', name: node.workflow.name },
          }
        case 'branch':
        case 'parallel':
          return {
            name: node.name,
            kind: node.kind,
            cases: Object.entries(node.cases).map(
              ([key, branchCase]): WorkflowGraphCase =>
                branchCase.kind === 'activity'
                  ? { key, kind: branchCase.kind }
                  : {
                      key,
                      kind: branchCase.kind,
                      target: {
                        kind: branchCase.kind,
                        // BranchCaseDefinition's conditional payload doesn't
                        // narrow on `kind` at the union default, so the cast
                        // lives here once instead of in every consumer.
                        name: (
                          branchCase as unknown as {
                            target: AnyTaskDefinition | AnyWorkflowDefinition
                          }
                        ).target.name,
                      },
                    },
            ),
          }
        case 'mapTask':
          return {
            name: node.name,
            kind: node.kind,
            target: { kind: 'task', name: node.task.name },
            mode: node.mode,
          }
        case 'mapWorkflow':
          return {
            name: node.name,
            kind: node.kind,
            target: { kind: 'workflow', name: node.workflow.name },
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
    tasks: Array.from(input.tasks ?? [], (task) => ({ name: task.name })),
  }
}

/**
 * Wire-safe counterpart of a stored type: `Date` fields become ISO-8601
 * strings so the value survives JSON transport unchanged.
 */
export type WireSafe<T> = {
  [K in keyof T]: T[K] extends Date
    ? string
    : T[K] extends Date | undefined
      ? string | undefined
      : T[K]
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

export function toRunDto(run: StoredRun): RunDto {
  return {
    ...run,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  }
}

export function toNodeDto(node: StoredNode): NodeDto {
  return {
    ...node,
    createdAt: node.createdAt.toISOString(),
    updatedAt: node.updatedAt.toISOString(),
  }
}

export function toNodeChildDto(child: StoredNodeChild): NodeChildDto {
  return {
    ...child,
    createdAt: child.createdAt.toISOString(),
    updatedAt: child.updatedAt.toISOString(),
  }
}

export function toAttemptDto(attempt: StoredAttempt): AttemptDto {
  return {
    ...attempt,
    dispatchedAt: attempt.dispatchedAt.toISOString(),
    heartbeatAt: attempt.heartbeatAt?.toISOString(),
    completedAt: attempt.completedAt?.toISOString(),
  }
}

export function toRunSnapshotDto(snapshot: RunSnapshot): RunSnapshotDto {
  return {
    run: toRunDto(snapshot.run),
    nodes: snapshot.nodes.map(toNodeDto),
    children: snapshot.children.map(toNodeChildDto),
    attempts: snapshot.attempts.map(toAttemptDto),
  }
}
