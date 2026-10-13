import * as Context from 'effect/Context'

import type {
  WorkflowCaseImplementation,
  WorkflowNodeImplementation,
} from '../../src/implement/index.ts'
import {
  runExecutionWorker,
  runWorkflowWorker,
} from '../../src/effect/index.ts'
import {
  createWorkflowRuntimeClient,
  isTerminalRunStatus,
  type InMemoryWorkflowRuntime,
} from '../../src/runtime/index.ts'

type Workers = Parameters<typeof runExecutionWorker>[0]

type Served = Pick<Workers, 'workflows' | 'tasks'>

/** The real workers, one drain of each queue per call. */
export function serve(
  served: Served,
  runtime: InMemoryWorkflowRuntime,
  context: Workers['context'] = Context.empty(),
) {
  const worker = { ...runtime, ...served, context, workerId: 'worker' }

  return {
    coordinate: () => runWorkflowWorker(worker),
    execute: () => runExecutionWorker(worker),
  }
}

/** Drives the real workers until the run settles. */
export async function settle(
  runId: string,
  served: Served,
  runtime: InMemoryWorkflowRuntime,
  context?: Workers['context'],
) {
  const client = createWorkflowRuntimeClient(runtime)
  const { coordinate, execute } = serve(served, runtime, context)

  for (let round = 0; round < 20; round++) {
    await coordinate()
    await execute()
    const snapshot = await client.get(runId)
    if (snapshot && isTerminalRunStatus(snapshot.run.status)) return snapshot
  }

  throw new Error(`Run [${runId}] did not settle`)
}

function shapeLeaf(leaf: WorkflowCaseImplementation) {
  const input = typeof leaf.input
  if (leaf.kind !== 'activity') return { ...leaf, input }

  const handler = typeof leaf.activity.handler
  return { ...leaf, input, activity: { ...leaf.activity, handler } }
}

/** A node without its callbacks and handlers, which no two builders share. */
export function shape(node: WorkflowNodeImplementation): unknown {
  switch (node.kind) {
    case 'branch':
    case 'parallel': {
      const cases: Record<string, unknown> = {}
      for (const [key, member] of Object.entries(node.cases)) {
        cases[key] = shapeLeaf(member)
      }
      const select = node.kind === 'branch' ? typeof node.select : undefined
      return { ...node, select, cases }
    }
    case 'mapTask':
    case 'mapWorkflow':
      return { ...node, items: typeof node.items, input: typeof node.input }
    default:
      return shapeLeaf(node)
  }
}
