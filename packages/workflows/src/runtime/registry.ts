import type {
  TaskImplementation,
  WorkflowCaseImplementation,
  WorkflowImplementation,
  WorkflowNodeImplementation,
} from '../implement/index.ts'

export type WorkflowRuntimeRegistry = {
  readonly workflows: ReadonlyMap<string, WorkflowImplementation>
  readonly tasks: ReadonlyMap<string, TaskImplementation>
  readonly getWorkflow: (name: string) => WorkflowImplementation | undefined
  readonly getTask: (name: string) => TaskImplementation | undefined
  readonly validateRouteability: (
    workflow: WorkflowImplementation,
  ) => readonly string[]
}

export function createWorkflowRuntimeRegistry(options: {
  workflows?: readonly WorkflowImplementation[]
  tasks?: readonly TaskImplementation[]
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
      const visited = new Set<WorkflowImplementation>()

      collectMissingWorkflowRoutes(workflow, workflows, tasks, missing, visited)

      return [...missing]
    },
  })

  return registry
}

function createWorkflowMap(workflows: readonly WorkflowImplementation[]) {
  const map = new Map<string, WorkflowImplementation>()

  for (const workflow of workflows) {
    const name = workflow.workflow.name
    if (map.has(name)) throw new Error(`Duplicate workflow implementation [${name}]`)
    map.set(name, workflow)
  }

  return map
}

function createTaskMap(tasks: readonly TaskImplementation[]) {
  const map = new Map<string, TaskImplementation>()

  for (const task of tasks) {
    const name = task.task.name
    if (map.has(name)) throw new Error(`Duplicate task implementation [${name}]`)
    map.set(name, task)
  }

  return map
}

function collectMissingWorkflowRoutes(
  workflow: WorkflowImplementation,
  workflows: ReadonlyMap<string, WorkflowImplementation>,
  tasks: ReadonlyMap<string, TaskImplementation>,
  missing: Set<string>,
  visited: Set<WorkflowImplementation>,
) {
  if (visited.has(workflow)) return
  visited.add(workflow)

  for (const node of workflow.nodes) {
    collectMissingRoute(node, workflows, tasks, missing, visited)
  }
}

function collectMissingRoute(
  node: WorkflowNodeImplementation | WorkflowCaseImplementation,
  workflows: ReadonlyMap<string, WorkflowImplementation>,
  tasks: ReadonlyMap<string, TaskImplementation>,
  missing: Set<string>,
  visited: Set<WorkflowImplementation>,
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
