// Browser-safe: this entry and what it imports at run time must stay free of
// Node APIs, so a dashboard can show runs and graphs an API serves without
// bundling the engine. Hashing a graph needs `node:crypto` and is in the
// package's main entry.
import type { RunDetail, RunInspection } from './client.ts'
import type { Definition, WorkflowGraph } from './graph/structure.ts'
import type {
  NodeStatus,
  ParsedChildKey,
  Route,
  RunSummary,
  StoredError,
  StoredOperation,
  Timestamp,
} from './model.ts'
import { labels, serializeWorkflowGraph } from './graph/structure.ts'
import { isTerminal, parseChildKey } from './model.ts'

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

/** One attempt of an operation's work, as a view of a durable run shows it. */
export type AttemptView = RunDetail['attempts'][number]

type OperationBase = {
  readonly name: string
  /** The order the run admitted its operations in. */
  readonly ordinal: number
  readonly status: NodeStatus
  readonly error?: StoredError
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

/** One operation of a durable run, by what it is. */
export type OperationView = OperationBase &
  (
    | {
        readonly kind: 'task' | 'workflow'
        readonly target?: Route
        /** The run doing the work; absent while none was started. */
        readonly childRun?: RunSummary
        /** Its attempts, when the detail was read with `children`. */
        readonly attempts?: readonly AttemptView[]
        readonly limits?: StoredOperation['limits']
        /** Its work failed and blocks the run until resumed. */
        readonly blocked: boolean
      }
    | { readonly kind: 'sleep'; readonly until?: Timestamp }
    | { readonly kind: 'now' }
    | {
        readonly kind: 'input'
        readonly family: string
        readonly key: string
        /**
         * `waiting`: the run waits for it. `buffered`: a value is kept for
         * the run, which has not come to it. `received`: the run read it.
         * `timedOut`: the wait ended with no value. `cancelled`: the run let
         * go of it.
         */
        readonly state:
          | 'waiting'
          | 'buffered'
          | 'received'
          | 'timedOut'
          | 'cancelled'
        readonly until?: Timestamp
        readonly receivedAt?: Timestamp
        readonly readAt?: Timestamp
      }
  )

/**
 * What blocks a durable run, and what may unblock it. The actions are
 * advice: the command decides again from what is stored.
 */
export type BlockerView =
  /** An operation whose work failed: `resume` runs it again. */
  | {
      readonly kind: 'operation'
      readonly operation: string
      readonly error?: StoredError
      readonly actions: readonly ('resume' | 'cancel')[]
    }
  /** A replay that no longer matched: resume once code that does is deployed. */
  | {
      readonly kind: 'mismatch'
      readonly error: StoredError
      readonly actions: readonly ('resume' | 'cancel')[]
    }
  /**
   * A child run that is blocked itself: it is the child that is resumed. Its
   * parent waits on it and is not blocked by it.
   */
  | {
      readonly kind: 'child'
      readonly operation: string
      readonly childRunId: string
      readonly actions: readonly 'resume'[]
    }

/** A durable run as people look at it: its operations and what blocks it. */
export type DurableRunView = {
  readonly run: RunSummary
  /** In the order the run admitted them. */
  readonly operations: readonly OperationView[]
  readonly blockers: readonly BlockerView[]
}

/**
 * Whether a run is a durable workflow's: by the graph it was created with,
 * or, with none to trust, by its nodes, every one of which a durable body
 * asked for. A run with no node yet and no graph cannot be told.
 */
function durable({ detail, definition }: RunInspection): boolean {
  if (definition.source === 'saved') {
    const { structure } = definition
    return structure.kind === 'workflow' && structure.mode === 'durable'
  }
  const { nodes } = detail
  return nodes.length > 0 && nodes.every(({ operation }) => operation)
}

/**
 * The view of a durable run from its inspection, read with `children` for
 * the attempts of each operation's work; `undefined` for any other run.
 * Pure, so it runs where the inspection is shown.
 */
export function durableView(
  inspection: RunInspection,
): DurableRunView | undefined {
  if (!durable(inspection)) return undefined
  const { run, nodes, children, childRuns, childDetails } = inspection.detail
  const runs = new Map(childRuns.map((child) => [child.id, child]))
  const edges = new Map(children.map((child) => [child.nodeName, child]))

  const operations = nodes
    .toSorted(
      (a, b) => (a.operation?.ordinal ?? 0) - (b.operation?.ordinal ?? 0),
    )
    .map((node): OperationView => {
      const operation = node.operation!
      const base = {
        name: node.name,
        ordinal: operation.ordinal,
        status: node.status,
        ...(node.error === undefined ? {} : { error: node.error }),
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
      }
      switch (node.kind) {
        case 'task':
        case 'workflow': {
          const child = edges.get(node.name)
          const childRunId = child?.childRunId
          const childRun =
            childRunId === undefined ? undefined : runs.get(childRunId)
          const work =
            childRunId === undefined ? undefined : childDetails?.[childRunId]
          return {
            ...base,
            kind: node.kind,
            ...(operation.target === undefined
              ? {}
              : { target: operation.target }),
            ...(childRun === undefined ? {} : { childRun }),
            ...(work === undefined ? {} : { attempts: work.attempts }),
            ...(operation.limits === undefined
              ? {}
              : { limits: operation.limits }),
            blocked: operation.blocked === true,
          }
        }
        case 'sleep':
          return {
            ...base,
            kind: 'sleep',
            ...(operation.until === undefined
              ? {}
              : { until: operation.until }),
          }
        case 'input': {
          const state =
            node.status === 'cancelled'
              ? 'cancelled'
              : operation.timedOut
                ? 'timedOut'
                : node.status !== 'completed'
                  ? 'waiting'
                  : operation.readAt === undefined
                    ? 'buffered'
                    : 'received'
          const { until, receivedAt, readAt } = operation
          return {
            ...base,
            kind: 'input',
            family: operation.input?.family ?? '',
            key: operation.input?.key ?? '',
            state,
            ...(until === undefined ? {} : { until }),
            ...(receivedAt === undefined ? {} : { receivedAt }),
            ...(readAt === undefined ? {} : { readAt }),
          }
        }
        default:
          return { ...base, kind: 'now' }
      }
    })

  // Only a run that is blocked now is blocked by its marks: one cancelled
  // or timed out keeps them as they were, with nothing left to resume.
  const blocked = run.status === 'blocked'
  const going = !isTerminal(run.status) && run.status !== 'cancelling'
  const blockers: BlockerView[] = []
  if (blocked && run.error?.name === 'ReplayMismatch') {
    blockers.push({
      kind: 'mismatch',
      error: run.error,
      actions: ['resume', 'cancel'],
    })
  }
  for (const operation of operations) {
    if (operation.kind !== 'task' && operation.kind !== 'workflow') continue
    if (operation.blocked && blocked) {
      blockers.push({
        kind: 'operation',
        operation: operation.name,
        ...(operation.error === undefined ? {} : { error: operation.error }),
        actions: ['resume', 'cancel'],
      })
    } else if (going && operation.childRun?.status === 'blocked') {
      blockers.push({
        kind: 'child',
        operation: operation.name,
        childRunId: operation.childRun.id,
        actions: ['resume'],
      })
    }
  }
  return { run, operations, blockers }
}
