import type {
  TaskImplementation,
  WorkflowCaseImplementation,
  WorkflowImplementation,
  WorkflowNodeImplementation,
} from '../implement/index.ts'
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  RunnableDefinition,
} from '../types/index.ts'
import type { RouteRef } from './commands.ts'

export type RegisteredWorkflowImplementation = WorkflowImplementation<
  AnyWorkflowDefinition,
  any
>
export type RegisteredTaskImplementation = TaskImplementation<
  AnyTaskDefinition,
  any
>

export type WorkflowRuntimeRegistry = {
  readonly workflows: readonly RegisteredWorkflowImplementation[]
  readonly tasks: readonly RegisteredTaskImplementation[]
  /** Exact: an absent revision finds the unversioned implementation only. */
  readonly getWorkflow: (
    name: string,
    revision?: string,
  ) => RegisteredWorkflowImplementation | undefined
  readonly getTask: (
    name: string,
    revision?: string,
  ) => RegisteredTaskImplementation | undefined
  readonly validateRouteability: (
    workflow: RegisteredWorkflowImplementation,
  ) => readonly string[]
}

// Revisions nest under their name, so no name or revision can be chosen to
// collide with another pair the way a joined string key could.
type Lane<T> = Map<string, Map<string | undefined, T>>

export function createWorkflowRuntimeRegistry(options: {
  workflows?: readonly RegisteredWorkflowImplementation[]
  tasks?: readonly RegisteredTaskImplementation[]
}): WorkflowRuntimeRegistry {
  const workflows = options.workflows ?? []
  const tasks = options.tasks ?? []
  const workflowLane = createLane(workflows, ({ workflow }) => workflow)
  const taskLane = createLane(tasks, ({ task }) => task)

  const getWorkflow = (name: string, revision?: string) =>
    workflowLane.get(name)?.get(revision)
  const getTask = (name: string, revision?: string) =>
    taskLane.get(name)?.get(revision)

  return Object.freeze({
    workflows,
    tasks,
    getWorkflow,
    getTask,
    validateRouteability: (workflow) => {
      const missing = new Set<string>()
      const visited = new Set<RegisteredWorkflowImplementation>()

      collectMissingWorkflowRoutes(
        workflow,
        { getWorkflow, getTask },
        missing,
        visited,
      )

      return Array.from(missing)
    },
  })
}

function createLane<T>(
  implementations: readonly T[],
  definitionOf: (implementation: T) => RunnableDefinition,
): Lane<T> {
  const lane: Lane<T> = new Map()

  for (const implementation of implementations) {
    const definition = definitionOf(implementation)
    const { kind, name, revision } = definition
    let revisions = lane.get(name)
    if (!revisions) {
      revisions = new Map()
      lane.set(name, revisions)
    }
    if (revisions.has(revision)) {
      throw new Error(
        `Duplicate ${kind} implementation [${routeLabel(definition)}]`,
      )
    }
    revisions.set(revision, implementation)
  }

  return lane
}

export function routeRef({ name, revision }: RouteRef): RouteRef {
  return { name, ...(revision === undefined ? {} : { revision }) }
}

/** `name` for the unversioned lane, `name@revision` otherwise. */
export function routeLabel({ name, revision }: RouteRef): string {
  return revision === undefined ? name : `${name}@${revision}`
}

type Lookup = Pick<WorkflowRuntimeRegistry, 'getWorkflow' | 'getTask'>

function collectMissingWorkflowRoutes(
  workflow: RegisteredWorkflowImplementation,
  lookup: Lookup,
  missing: Set<string>,
  visited: Set<RegisteredWorkflowImplementation>,
) {
  if (visited.has(workflow)) return
  visited.add(workflow)

  for (const node of workflow.nodes) {
    collectMissingRoute(node, lookup, missing, visited)
  }
}

function collectMissingRoute(
  node: WorkflowNodeImplementation | WorkflowCaseImplementation,
  lookup: Lookup,
  missing: Set<string>,
  visited: Set<RegisteredWorkflowImplementation>,
) {
  switch (node.kind) {
    case 'task':
    case 'mapTask': {
      const { name, revision } = node.target
      const task = lookup.getTask(name, revision)
      if (task?.task !== node.target) {
        missing.add(`task:${routeLabel(node.target)}`)
      }
      return
    }

    case 'workflow':
    case 'mapWorkflow': {
      const { name, revision } = node.target
      const workflow = lookup.getWorkflow(name, revision)
      if (workflow?.workflow !== node.target) {
        missing.add(`workflow:${routeLabel(node.target)}`)
        return
      }

      collectMissingWorkflowRoutes(workflow, lookup, missing, visited)
      return
    }

    case 'branch':
    case 'parallel':
      for (const branchCase of Object.values(node.cases)) {
        collectMissingRoute(branchCase, lookup, missing, visited)
      }
      return

    case 'activity':
      return
  }
}
