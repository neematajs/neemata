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
  const workflows = new Map(
    (options.workflows ?? []).map((workflow) => [
      workflow.workflow.name,
      workflow,
    ]),
  )
  const tasks = new Map(
    (options.tasks ?? []).map((task) => [task.task.name, task]),
  )

  const registry: WorkflowRuntimeRegistry = Object.freeze({
    workflows,
    tasks,
    getWorkflow: (name) => workflows.get(name),
    getTask: (name) => tasks.get(name),
    validateRouteability: (workflow) => {
      const missing = new Set<string>()

      for (const node of workflow.nodes) {
        collectMissingRoute(node, workflows, tasks, missing)
      }

      return [...missing]
    },
  })

  return registry
}

function collectMissingRoute(
  node: WorkflowNodeImplementation | WorkflowCaseImplementation,
  workflows: ReadonlyMap<string, WorkflowImplementation>,
  tasks: ReadonlyMap<string, TaskImplementation>,
  missing: Set<string>,
) {
  switch (node.kind) {
    case 'task':
    case 'mapTask': {
      const name = node.target.name
      if (!tasks.has(name)) missing.add(`task:${name}`)
      return
    }

    case 'workflow':
    case 'mapWorkflow': {
      const name = node.target.name
      if (!workflows.has(name)) missing.add(`workflow:${name}`)
      return
    }

    case 'branch':
    case 'parallel':
      for (const branchCase of Object.values(node.cases)) {
        collectMissingRoute(branchCase, workflows, tasks, missing)
      }
      return

    case 'activity':
      return
  }
}
