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
  'dependencies' | 'finish'
> & {
  readonly dependencies: Dependencies
  readonly finish: (...args: any[]) => unknown
}

export type RegisteredTaskImplementation = Omit<
  TaskImplementation<AnyTaskDefinition, Dependencies>,
  'dependencies' | 'handler'
> & {
  readonly dependencies: Dependencies
  readonly handler: (...args: any[]) => unknown
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
  const workflows = indexByName(
    options.workflows ?? [],
    (implementation) => implementation.workflow.name,
    'workflow',
  )
  const tasks = indexByName(
    options.tasks ?? [],
    (implementation) => implementation.task.name,
    'task',
  )

  return Object.freeze({
    workflows,
    tasks,
    getWorkflow: (name) => workflows.get(name),
    getTask: (name) => tasks.get(name),
    validateRouteability: (entry) => {
      const missing = new Set<string>()
      const visited = new Set<RegisteredWorkflowImplementation>()

      const visitWorkflow = (workflow: RegisteredWorkflowImplementation) => {
        if (visited.has(workflow)) return
        visited.add(workflow)
        for (const node of workflow.nodes) visitNode(node)
      }

      const visitNode = (
        node: WorkflowNodeImplementation | WorkflowCaseImplementation,
      ) => {
        switch (node.kind) {
          case 'task':
          case 'mapTask': {
            const { name } = node.target
            if (tasks.get(name)?.task !== node.target) {
              missing.add(`task:${name}`)
            }
            return
          }

          case 'workflow':
          case 'mapWorkflow': {
            const { name } = node.target
            const workflow = workflows.get(name)
            if (workflow?.workflow !== node.target) {
              missing.add(`workflow:${name}`)
              return
            }

            visitWorkflow(workflow)
            return
          }

          case 'branch':
          case 'parallel':
            for (const branchCase of Object.values(node.cases)) {
              visitNode(branchCase)
            }
            return

          case 'activity':
            return
        }
      }

      visitWorkflow(entry)
      return Array.from(missing)
    },
  })
}

function indexByName<Implementation>(
  implementations: readonly Implementation[],
  nameOf: (implementation: Implementation) => string,
  label: string,
) {
  const byName = new Map<string, Implementation>()

  for (const implementation of implementations) {
    const name = nameOf(implementation)
    if (byName.has(name)) {
      throw new Error(`Duplicate ${label} implementation [${name}]`)
    }
    byName.set(name, implementation)
  }

  return byName
}
