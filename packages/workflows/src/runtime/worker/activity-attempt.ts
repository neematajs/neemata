import type { Container, DependencyContext } from '@nmtjs/core'

import type {
  ActivityNodeImplementation,
  AnyWorkflowImplementation,
  BranchNodeImplementation,
  ParallelNodeImplementation,
  WorkflowCaseImplementation,
} from '../../implement/index.ts'
import type { Schema } from '../../types/index.ts'
import type { ActivityAttemptCommand, ClaimedAttempt } from '../commands.ts'
import type { RuntimeDeps } from '../executors.ts'
import type { WorkflowWakeEvents } from '../wake-events.ts'
import { parseChildKey } from '../child-key.ts'
import { decodeSchemaValue } from '../coordinator/codec.ts'
import { parseDurationMs } from '../duration.ts'
import { createWorkflowRuntimeRegistry } from '../registry.ts'
import { isTerminalRunStatus } from '../status.ts'
import {
  runAtomicCompletion,
  type WorkflowRuntimeAtomicCompletion,
} from './atomic.ts'
import {
  isAttemptCancellationObserved,
  isAttemptShutdown,
  runWithAttemptHeartbeat,
} from './heartbeat.ts'
import { isAttemptHeartbeatLeaseLost } from './loop.ts'
import {
  ackTerminalAttempt,
  isFreshAttempt,
  loadAttemptState,
  reconcileStaleAttempt,
  releaseUnroutable,
  settleAttemptFailure,
  settleAttemptSuccess,
  type WorkerCommandResult,
} from './reconcile.ts'

export type RunActivityAttemptInput = RuntimeDeps & {
  readonly atomicCompletion?: WorkflowRuntimeAtomicCompletion
  readonly workflows: readonly AnyWorkflowImplementation[]
  readonly workerId: string
  readonly claimed: ClaimedAttempt
  readonly leaseMs?: number
  readonly signal?: AbortSignal
  readonly wakeEvents?: WorkflowWakeEvents
  readonly container: Pick<Container, 'createContext'>
}

export async function runActivityAttempt(
  input: RunActivityAttemptInput,
): Promise<WorkerCommandResult> {
  const command = input.claimed.command
  if (command.kind !== 'activityAttempt') {
    throw new Error(`Unsupported attempt command kind [${command.kind}]`)
  }

  const { snapshot, child, attempt } = await loadAttemptState(
    input.store,
    command,
  )
  if (snapshot && isTerminalRunStatus(snapshot.run.status)) {
    return await ackTerminalAttempt(input)
  }

  if (!isFreshAttempt(command, child, attempt)) {
    // Activities only ever run inside workflow runs, so no task run can be
    // settled from here.
    return await runAtomicCompletion(input, (scoped) =>
      reconcileStaleAttempt(scoped, command, child, attempt, false),
    )
  }

  if (snapshot?.run.workflowName !== command.workflowName) {
    return await releaseUnroutable(
      input,
      `Run [${command.runId}] workflow does not match command workflow [${command.workflowName}]`,
    )
  }

  const registry = createWorkflowRuntimeRegistry({ workflows: input.workflows })
  const workflow = registry.getWorkflow(command.workflowName)
  if (!workflow) {
    return await releaseUnroutable(
      input,
      `No registered workflow implementation [${command.workflowName}]`,
    )
  }

  const node = resolveActivityNode(workflow, command)
  if (!node) {
    return await releaseUnroutable(
      input,
      `No activity implementation for [${command.workflowName}.${command.nodeName}.${command.childKey}]`,
    )
  }

  let output: unknown
  try {
    const declaration = resolveActivityDeclaration(workflow, command)
    output = await runWithAttemptHeartbeat(
      { ...input, timeoutMs: declaration.timeoutMs },
      async (lifecycle) => {
        const ctx = await input.container.createContext(
          node.activity.dependencies,
        )
        return await node.activity.handler(
          ctx as DependencyContext<any>,
          command.input,
          lifecycle,
        )
      },
    )
    if (declaration.output) {
      output = decodeSchemaValue(
        declaration.output.schema,
        output,
        declaration.output.label,
      )
    }
  } catch (error) {
    if (isAttemptHeartbeatLeaseLost(error) || isAttemptShutdown(error)) {
      throw error
    }
    if (isAttemptCancellationObserved(error)) {
      return await ackTerminalAttempt(input)
    }
    return await runAtomicCompletion(input, (scoped) =>
      settleAttemptFailure(scoped, {
        command,
        error,
        retry: node.retry,
        taskRun: false,
      }),
    )
  }

  return await runAtomicCompletion(input, (scoped) =>
    settleAttemptSuccess(scoped, { command, output, taskRun: false }),
  )
}

/**
 * The command's childKey is authoritative: retries carry it, so member
 * resolution never depends on stored attempt bookkeeping.
 */
function resolveActivityNode(
  workflow: AnyWorkflowImplementation,
  command: ActivityAttemptCommand,
): ActivityNodeImplementation | undefined {
  const parsed = parseChildKey(command.childKey)
  if (!parsed) return undefined

  if (parsed.kind === 'self') {
    const direct = workflow.nodes.find(
      (candidate): candidate is ActivityNodeImplementation =>
        candidate.kind === 'activity' && candidate.name === command.nodeName,
    )
    if (!direct) return undefined
    return direct.activity.name === command.activityName ? direct : undefined
  }

  let selected: WorkflowCaseImplementation | undefined
  if (parsed.kind === 'case') {
    const branch = workflow.nodes.find(
      (candidate): candidate is BranchNodeImplementation =>
        candidate.kind === 'branch' && candidate.name === command.nodeName,
    )
    selected = branch?.cases[parsed.caseKey]
  }
  if (parsed.kind === 'member') {
    const parallel = workflow.nodes.find(
      (candidate): candidate is ParallelNodeImplementation =>
        candidate.kind === 'parallel' && candidate.name === command.nodeName,
    )
    selected = parallel?.cases[parsed.memberKey]
  }

  if (selected?.kind !== 'activity') return undefined

  return selected.activity.name === command.activityName ? selected : undefined
}

type ActivityDeclaration = {
  readonly timeoutMs?: number
  readonly output?: { readonly schema: Schema; readonly label: string }
}

/** Definition-side timeout and output schema for the node the command targets. */
function resolveActivityDeclaration(
  workflow: AnyWorkflowImplementation,
  command: ActivityAttemptCommand,
): ActivityDeclaration {
  const declaration = workflow.workflow.nodes.find(
    (candidate) => candidate.name === command.nodeName,
  )
  if (!declaration) return {}

  const workflowName = workflow.workflow.name
  if (declaration.kind === 'activity') {
    return {
      timeoutMs: parseDurationMs(declaration.timeout),
      output: {
        schema: declaration.output,
        label: `activity output [${workflowName}.${command.nodeName}]`,
      },
    }
  }
  if (declaration.kind !== 'branch' && declaration.kind !== 'parallel') {
    return {}
  }

  const parsed = parseChildKey(command.childKey)
  let caseKey: string | undefined
  if (parsed?.kind === 'case') caseKey = parsed.caseKey
  if (parsed?.kind === 'member') caseKey = parsed.memberKey
  const selected =
    caseKey === undefined ? undefined : declaration.cases[caseKey]
  if (selected?.kind !== 'activity') return {}

  return {
    timeoutMs: parseDurationMs(selected.timeout),
    output: {
      schema: selected.output,
      label: `activity output [${workflowName}.${command.nodeName}.${command.childKey}]`,
    },
  }
}
