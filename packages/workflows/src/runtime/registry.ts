import type { Dependencies } from '@nmtjs/core'

import type {
  TaskImplementation,
  WorkflowCaseImplementation,
  WorkflowImplementation,
  WorkflowNodeImplementation,
} from '../implement/index.ts'
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
} from '../types/index.ts'

export type RegisteredWorkflowImplementation = Omit<
  WorkflowImplementation<AnyWorkflowDefinition, Dependencies>,
  'dependencies' | 'finish' | 'idempotency' | 'tags'
> & {
  readonly dependencies: Dependencies
  readonly finish: (...args: any[]) => unknown
  readonly idempotency?: unknown
  readonly tags?: unknown
}

export type RegisteredTaskImplementation = Omit<
  TaskImplementation<AnyTaskDefinition, Dependencies>,
  'dependencies' | 'handler' | 'idempotency'
> & {
  readonly dependencies: Dependencies
  readonly handler: (...args: any[]) => unknown
  readonly idempotency?: unknown
}

export type WorkflowRuntimeRegistry = {
  readonly workflows: ReadonlyMap<string, RegisteredWorkflowImplementation>
  readonly tasks: ReadonlyMap<string, RegisteredTaskImplementation>
  readonly getWorkflow: (
    name: string,
  ) => RegisteredWorkflowImplementation | undefined
  readonly getTask: (name: string) => RegisteredTaskImplementation | undefined
  readonly validateRouteability: (
    workflow: RegisteredWorkflowImplementation,
  ) => readonly string[]
}

export function createWorkflowRuntimeRegistry(options: {
  workflows?: readonly RegisteredWorkflowImplementation[]
  tasks?: readonly RegisteredTaskImplementation[]
}): WorkflowRuntimeRegistry {
  const workflows = createWorkflowMap(options.workflows ?? [])
  const tasks = createTaskMap(options.tasks ?? [])

  const registry: WorkflowRuntimeRegistry = Object.freeze({
    workflows,
    tasks,
    getWorkflow: (name) => workflows.get(name),
    getTask: (name) => tasks.get(name),
    validateRouteability: (workflow) => {
      const missing = new Set<string>()
      const visited = new Set<RegisteredWorkflowImplementation>()

      collectMissingWorkflowRoutes(workflow, workflows, tasks, missing, visited)

      return [...missing]
    },
  })

  return registry
}

function createWorkflowMap(
  workflows: readonly RegisteredWorkflowImplementation[],
) {
  const map = new Map<string, RegisteredWorkflowImplementation>()

  for (const workflow of workflows) {
    const name = workflow.workflow.name
    if (map.has(name))
      throw new Error(`Duplicate workflow implementation [${name}]`)
    map.set(name, workflow)
  }

  return map
}

function createTaskMap(tasks: readonly RegisteredTaskImplementation[]) {
  const map = new Map<string, RegisteredTaskImplementation>()

  for (const task of tasks) {
    const name = task.task.name
    if (map.has(name))
      throw new Error(`Duplicate task implementation [${name}]`)
    map.set(name, task)
  }

  return map
}

function collectMissingWorkflowRoutes(
  workflow: RegisteredWorkflowImplementation,
  workflows: ReadonlyMap<string, RegisteredWorkflowImplementation>,
  tasks: ReadonlyMap<string, RegisteredTaskImplementation>,
  missing: Set<string>,
  visited: Set<RegisteredWorkflowImplementation>,
) {
  if (visited.has(workflow)) return
  visited.add(workflow)

  for (const node of workflow.nodes) {
    collectMissingRoute(node, workflows, tasks, missing, visited)
  }
}

function collectMissingRoute(
  node: WorkflowNodeImplementation | WorkflowCaseImplementation,
  workflows: ReadonlyMap<string, RegisteredWorkflowImplementation>,
  tasks: ReadonlyMap<string, RegisteredTaskImplementation>,
  missing: Set<string>,
  visited: Set<RegisteredWorkflowImplementation>,
) {
  switch (node.kind) {
    case 'task':
    case 'mapTask': {
      const name = node.target.name
      const task = tasks.get(name)
      if (task?.task !== node.target) missing.add(`task:${name}`)
      return
    }

    case 'workflow':
    case 'mapWorkflow': {
      const name = node.target.name
      const workflow = workflows.get(name)
      if (workflow?.workflow !== node.target) {
        missing.add(`workflow:${name}`)
        return
      }

      collectMissingWorkflowRoutes(workflow, workflows, tasks, missing, visited)
      return
    }

    case 'branch':
    case 'parallel':
      for (const branchCase of Object.values(node.cases)) {
        collectMissingRoute(branchCase, workflows, tasks, missing, visited)
      }
      return

    case 'activity':
      return
  }
}
