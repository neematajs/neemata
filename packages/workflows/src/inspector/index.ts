import type {
  AttemptSummary,
  NodeChildSummary,
  RunDetail,
  RunSummary,
} from '../runtime/store.ts'
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  BranchCaseDefinition,
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
  /** Fan-out completion mode for mapTask and mapWorkflow nodes. */
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
  const base = { name: definition.name, ...metadata(definition) }
  const nodes = definition.nodes.map((node): WorkflowGraphNode => {
    const base = { name: node.name, kind: node.kind, ...metadata(node) }

    switch (node.kind) {
      case 'activity':
        return base
      case 'task':
      case 'mapTask': {
        const target = serializeTarget('task', node.task)
        return { ...base, target }
      }
      case 'workflow':
      case 'mapWorkflow': {
        const target = serializeTarget('workflow', node.workflow)
        return { ...base, target }
      }
      case 'branch':
      case 'parallel': {
        const cases: WorkflowGraphCase[] = []

        for (const key in node.cases) {
          const branchCase = node.cases[key]
          const graphCase = {
            key,
            kind: branchCase.kind,
            ...metadata(branchCase),
          }
          if (branchCase.kind === 'activity') {
            cases.push(graphCase)
            continue
          }

          // BranchCaseDefinition's conditional payload doesn't narrow on
          // `kind` at the union default, so the cast lives here once.
          const reference = branchCase as BranchCaseDefinition<
            'task' | 'workflow'
          >
          const target = serializeTarget(reference.kind, reference.target)
          cases.push({ ...graphCase, target })
        }

        return { ...base, cases }
      }
    }
  })

  return { ...base, nodes }
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

export type NodeUnit = {
  readonly key: string
  readonly parsed?: ParsedChildKey
  readonly child: NodeChildSummary
  readonly attempts: readonly AttemptSummary[]
  readonly childRun?: RunSummary
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
