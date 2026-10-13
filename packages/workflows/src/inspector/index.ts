import type {
  AttemptSummary,
  NodeChildSummary,
  RunDetail,
  RunSummary,
} from '../runtime/store.ts'
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
} from '../types/index.ts'
import type {
  DefinitionStructure,
  GraphPresentation,
  RevisionManifest,
  StoredGraph,
  WorkflowGraph,
} from './graph.ts'
import { parseChildKey, type ParsedChildKey } from '../runtime/child-key.ts'
import { labels, serializeWorkflowGraph } from './graph.ts'

export {
  canonicalJson,
  captureGraphPresentation,
  parseStructure,
  projectStructure,
  renderWorkflowGraph,
  serializeWorkflowGraph,
  STRUCTURE_FORMAT_VERSION,
  structureSlots,
} from './graph.ts'
export type {
  DefinitionBundle,
  DefinitionStructure,
  GraphCaseLabels,
  GraphLabels,
  GraphNodeLabels,
  GraphPresentation,
  RevisionBinding,
  RevisionManifest,
  StoredGraph,
  StructuralCase,
  StructuralNode,
  StructuralSlot,
  StructuralTarget,
  TaskStructure,
  WorkflowGraph,
  WorkflowGraphCase,
  WorkflowGraphNode,
  WorkflowGraphTarget,
  WorkflowStructure,
} from './graph.ts'

/**
 * How a run's definition can be shown. `saved` is the graph the run was created
 * with, in declared order and including alternatives it never took. `observed`
 * means no trustworthy graph exists for the run: `detail` holds everything
 * known, and neither order, unused alternatives nor labels may be filled in
 * from a definition deployed today.
 */
export type RunDefinitionInspection =
  | {
      readonly source: 'saved'
      readonly graphHash: string
      readonly structure: DefinitionStructure
      /** Absent when the definition declared no labels. */
      readonly presentation?: GraphPresentation
      /** Absent for unversioned runs, which have no pinned bindings. */
      readonly revision?: RevisionManifest
    }
  | {
      readonly source: 'observed'
      /**
       * `legacy`: the run predates saved graphs. `missing-graph`: its graph
       * record is gone. `invalid-graph`: the record does not match its hash.
       */
      readonly reason: 'legacy' | 'missing-graph' | 'invalid-graph'
    }

export type RunInspection = {
  readonly detail: RunDetail
  readonly definition: RunDefinitionInspection
}

/** A saved revision with its graph, for previewing targets a run never reached. */
export type SavedDefinition = {
  readonly revision: RevisionManifest
  readonly graph: StoredGraph
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
    ...labels(task),
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
