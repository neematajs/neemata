// Browser-safe: this entry and what it imports at run time must stay free of
// Node APIs, so a dashboard can show runs and graphs an API serves without
// bundling the engine. Hashing a graph needs `node:crypto` and is in the
// package's main entry.
import type { RunDetail } from './client.ts'
import type { Definition, WorkflowGraph } from './graph/structure.ts'
import type { ParsedChildKey, RunSummary } from './model.ts'
import { labels, serializeWorkflowGraph } from './graph/structure.ts'
import { parseChildKey } from './model.ts'

export type {
  RunDefinition,
  RunDetail,
  RunInspection,
  SavedDefinition,
} from './client.ts'
export type {
  RevisionBinding,
  RevisionManifest,
  RunnableRevision,
} from './graph/revision.ts'
export {
  canonicalJson,
  captureGraphPresentation,
  parseStructure,
  projectStructure,
  renderWorkflowGraph,
  serializeWorkflowGraph,
  STRUCTURE_FORMAT_VERSION,
  structureSlots,
} from './graph/structure.ts'
export type {
  Definition,
  DefinitionStructure,
  GraphCaseLabels,
  GraphLabels,
  GraphNodeLabels,
  GraphPresentation,
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
} from './graph/structure.ts'
export {
  caseKey,
  isTerminal,
  itemKey,
  memberKey,
  parseChildKey,
  SELF,
  STATUSES,
  TASK,
} from './model.ts'
export type * from './model.ts'

export type WorkflowCatalogTask = {
  readonly name: string
  readonly title?: string
  readonly description?: string
}

export type WorkflowCatalog = {
  readonly workflows: readonly WorkflowGraph[]
  readonly tasks: readonly WorkflowCatalogTask[]
}

/**
 * What exists and what it looks like, for a set of declarations as they are
 * now. It takes as much of a declaration as a graph does, so whoever holds
 * declarations can make the catalog.
 */
export function serializeWorkflowCatalog(input: {
  readonly workflows?: Iterable<Extract<Definition, { kind: 'workflow' }>>
  readonly tasks?: Iterable<Extract<Definition, { kind: 'task' }>>
}): WorkflowCatalog {
  return {
    workflows: Array.from(input.workflows ?? [], serializeWorkflowGraph),
    tasks: Array.from(input.tasks ?? [], (task) => ({
      name: task.name,
      ...labels(task),
    })),
  }
}

/** One child of a node with its attempts, and the run it started. */
export type NodeUnit = {
  readonly key: string
  /** Absent for a key the engine never wrote. */
  readonly parsed?: ParsedChildKey
  readonly child: RunDetail['children'][number]
  /** In the order they were made. */
  readonly attempts: readonly RunDetail['attempts'][number][]
  readonly childRun?: RunSummary
}

/**
 * The children of one node of a run, each with what it ran: map items in the
 * order of their items, cases and members in that of their keys, compared
 * as `localeCompare` does: `a` before `A` before `ä` before `z`.
 */
export function nodeUnits(
  detail: RunDetail,
  nodeName: string,
): readonly NodeUnit[] {
  const childRuns = new Map(detail.childRuns.map((run) => [run.id, run]))
  const own = <Record extends { readonly nodeName: string }>(
    records: readonly Record[],
  ) => records.filter((record) => record.nodeName === nodeName)

  const attempts = new Map<string, RunDetail['attempts'][number][]>()
  for (const attempt of own(detail.attempts).sort(
    (a, b) => a.attemptNumber - b.attemptNumber,
  )) {
    const made = attempts.get(attempt.childKey) ?? []
    attempts.set(attempt.childKey, [...made, attempt])
  }
  return own(detail.children)
    .sort(
      (a, b) =>
        (a.ordinal ?? 0) - (b.ordinal ?? 0) ||
        a.childKey.localeCompare(b.childKey),
    )
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
        attempts: attempts.get(child.childKey) ?? [],
        ...(childRun === undefined ? {} : { childRun }),
      }
    })
}
