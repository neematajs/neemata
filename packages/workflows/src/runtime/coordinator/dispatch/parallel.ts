import type {
  ParallelNodeImplementation,
  WorkflowCaseImplementation,
} from '../../../implement/index.ts'
import type {
  AnyTaskDefinition,
  BranchCaseDefinition,
} from '../../../types/index.ts'
import type { StoredNodeChild, StoredRun } from '../../state.ts'
import type { AdvanceCtx, AdvanceOutcome } from '../context.ts'
import { memberChildKey } from '../../child-key.ts'
import { isTerminalNodeStatus, isTerminalRunStatus } from '../../status.ts'
import { dispatchTaskRunAttempt, dispatchActivityAttempt } from '../attempt.ts'
import { cancelNodeChildRunsAndCommands } from '../cancel.ts'
import {
  decodeWorkflowUserSchemaValue,
  getWorkflowNodeDeclaration,
  resolveIdempotency,
} from '../codec.ts'
import { runWorkflowUserCallback } from '../context.ts'
import {
  cancelNodeAndRun,
  failMissingChildRun,
  failNodeAndRun,
} from '../sinks.ts'

export async function dispatchParallelNode(
  input: AdvanceCtx & {
    readonly node: ParallelNodeImplementation
  },
): Promise<AdvanceOutcome> {
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: input.node.name,
    kind: 'parallel',
  })
  if (isTerminalNodeStatus(existing.status)) return 'parked'

  const declaration = getWorkflowNodeDeclaration(
    input.workflow,
    input.node.name,
  )
  if (declaration.kind !== 'parallel') {
    throw new Error(`Workflow node [${input.node.name}] is not parallel`)
  }
  for (const memberKey of Object.keys(input.node.cases)) {
    if (!declaration.cases[memberKey]) {
      throw new Error(
        `Missing parallel member declaration [${input.node.name}.${memberKey}]`,
      )
    }
  }

  const ensured = await input.store.ensureNodeChildren({
    runId: input.run.id,
    nodeName: input.node.name,
    children: Object.entries(input.node.cases).map(([memberKey, member]) => ({
      childKey: memberChildKey(memberKey),
      kind: member.kind,
    })),
  })
  const childByKey = new Map(
    ensured.children.map((child) => [child.childKey, child]),
  )
  // Per-member snapshot loads cost one round-trip each, so load all child
  // run rows in one query instead.
  const childRuns = new Map(
    (
      await input.store.loadRuns(
        ensured.children
          .map((child) => child.childRunId)
          .filter((runId): runId is string => runId !== undefined),
      )
    ).map((run) => [run.id, run]),
  )

  const outputs: Record<string, unknown> = {}
  let hasLocalWork = false

  const failMember = async (error: unknown, child: StoredNodeChild) => {
    await input.store.failNodeChild({
      runId: input.run.id,
      nodeName: input.node.name,
      childKey: child.childKey,
      error,
    })
    await cancelNodeChildRunsAndCommands({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: input.run.id,
      nodeName: input.node.name,
    })
    await failNodeAndRun({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: input.run.id,
      nodeName: input.node.name,
      error,
    })
  }

  for (const [memberKey, member] of Object.entries(input.node.cases)) {
    const childKey = memberChildKey(memberKey)
    const child = childByKey.get(childKey)
    if (!child) {
      throw new Error(
        `Missing parallel member child [${input.node.name}.${memberKey}]`,
      )
    }

    if (child.status === 'completed') {
      outputs[memberKey] = child.output
      continue
    }
    if (child.status === 'failed') {
      const error =
        child.error ??
        new Error(`Parallel member [${input.node.name}.${memberKey}] failed`)
      await cancelNodeChildRunsAndCommands({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        runId: input.run.id,
        nodeName: input.node.name,
      })
      await failNodeAndRun({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        runId: input.run.id,
        nodeName: input.node.name,
        error,
      })
      return 'terminal'
    }
    if (child.status === 'cancelled') {
      await cancelNodeAndRun({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        runId: input.run.id,
        nodeName: input.node.name,
      })
      return 'terminal'
    }

    if (member.kind === 'workflow' || member.kind === 'task') {
      if (child.childRunId !== undefined) {
        const childRun = childRuns.get(child.childRunId)
        if (!childRun) {
          await failMissingChildRun({
            store: input.store,
            runCoordinationExecutor: input.runCoordinationExecutor,
            parentRunId: input.run.id,
            nodeName: input.node.name,
            childKind: member.kind,
            childRunId: child.childRunId,
          })
          return 'terminal'
        }

        if (!isTerminalRunStatus(childRun.status)) {
          await redispatchParallelChildRun(input, member, memberKey, childRun)
          continue
        }
        if (childRun.status === 'completed') {
          await input.store.completeNodeChild({
            runId: input.run.id,
            nodeName: input.node.name,
            childKey,
            output: childRun.output,
          })
          outputs[memberKey] = childRun.output
          continue
        }
        if (childRun.status === 'cancelled') {
          await cancelNodeAndRun({
            store: input.store,
            attemptExecutor: input.attemptExecutor,
            runCoordinationExecutor: input.runCoordinationExecutor,
            runId: input.run.id,
            nodeName: input.node.name,
          })
          return 'terminal'
        }

        const error =
          childRun.error ??
          new Error(
            `Parallel child ${member.kind} run [${childRun.id}] ${childRun.status}`,
          )
        await failMember(error, child)
        return 'terminal'
      }

      const memberDeclaration = declaration.cases[memberKey]!
      const nodeInput = decodeWorkflowUserSchemaValue(
        member.target.input,
        member.input
          ? runWorkflowUserCallback(() =>
              member.input!(input.workflowCtx, input.outputs, input.run.input),
            )
          : input.run.input,
        `${member.kind} input [${input.workflow.workflow.name}.${input.node.name}.${memberKey}]`,
      )
      const idempotencyKey = resolveIdempotency(
        member.idempotency,
        input.workflowCtx,
        input.outputs,
        input.run.input,
      )
      const created = await input.store.ensureChildRun({
        runId: input.run.id,
        nodeName: input.node.name,
        childKey,
        childKind: member.kind,
        childName: member.target.name,
        input: nodeInput,
        rootRunId: input.run.rootRunId,
        idempotencyKey,
      })
      if (member.kind === 'workflow') {
        await input.runCoordinationExecutor.enqueue({
          kind: 'continueRun',
          runId: created.childRun.id,
          workflowName: member.target.name,
        })
      } else {
        const taskDeclaration = memberDeclaration as BranchCaseDefinition<
          'task',
          unknown,
          unknown,
          AnyTaskDefinition
        >
        const taskTarget = member.target as AnyTaskDefinition
        await dispatchTaskRunAttempt({
          store: input.store,
          attemptExecutor: input.attemptExecutor,
          runCoordinationExecutor: input.runCoordinationExecutor,
          taskName: taskTarget.name,
          taskRunId: created.childRun.id,
          taskInput: nodeInput,
          idempotencyKey,
          timeout: taskDeclaration.timeout ?? taskTarget.timeout,
        })
      }
      continue
    }

    if (member.kind !== 'activity') {
      throw unsupportedParallelCase(input.node.name, member)
    }

    const memberDeclaration = declaration.cases[memberKey]
    if (memberDeclaration?.kind !== 'activity') {
      throw new Error(
        `Parallel member [${input.node.name}.${memberKey}] is not an activity`,
      )
    }
    const activityMemberDeclaration =
      memberDeclaration as BranchCaseDefinition<'activity'>

    // Once the member has an attempt, its input is authoritative — never
    // re-run the user's input callback on re-entry.
    const hasAttempt = child.attemptCount > 0
    const nodeInput = hasAttempt
      ? undefined
      : decodeWorkflowUserSchemaValue(
          activityMemberDeclaration.input,
          member.input
            ? runWorkflowUserCallback(() =>
                member.input!(
                  input.workflowCtx,
                  input.outputs,
                  input.run.input,
                ),
              )
            : input.run.input,
          `activity input [${input.workflow.workflow.name}.${input.node.name}.${memberKey}]`,
        )
    const idempotencyKey = hasAttempt
      ? undefined
      : resolveIdempotency(
          member.idempotency,
          input.workflowCtx,
          input.outputs,
          input.run.input,
        )

    await dispatchActivityAttempt({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      runCoordinationExecutor: input.runCoordinationExecutor,
      workflowName: input.workflow.workflow.name,
      activityName: member.activity.name,
      runId: input.run.id,
      nodeName: input.node.name,
      childKey,
      prepareAttempt: async () => {
        const result = await input.store.ensureChildAttempt({
          runId: input.run.id,
          nodeName: input.node.name,
          childKey,
          input: nodeInput,
          idempotencyKey,
        })
        return {
          attempt: result.attempt,
          commandInput: result.created ? nodeInput : result.attempt.input,
          created: result.created,
        }
      },
    })
    hasLocalWork = true
  }

  const expectedCount = Object.keys(input.node.cases).length
  if (Object.keys(outputs).length === expectedCount) {
    await input.store.completeNode({
      runId: input.run.id,
      nodeName: input.node.name,
      output: outputs,
    })
    return await input.advance({
      ...input,
      outputs: { ...input.outputs, [input.node.name]: outputs },
    })
  }

  await input.store.waitNode({
    runId: input.run.id,
    nodeName: input.node.name,
  })
  return hasLocalWork ? 'local' : 'parked'
}

async function redispatchParallelChildRun(
  input: AdvanceCtx & { readonly node: ParallelNodeImplementation },
  member: WorkflowCaseImplementation,
  memberKey: string,
  childRun: StoredRun,
): Promise<void> {
  if (member.kind === 'workflow') {
    await input.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: childRun.id,
      workflowName: childRun.workflowName,
    })
    return
  }
  if (member.kind !== 'task') return

  const declaration = getWorkflowNodeDeclaration(
    input.workflow,
    input.node.name,
  )
  if (declaration.kind !== 'parallel') return
  const taskDeclaration = declaration.cases[memberKey] as
    | BranchCaseDefinition<'task', unknown, unknown, AnyTaskDefinition>
    | undefined
  const taskTarget = member.target as AnyTaskDefinition
  await dispatchTaskRunAttempt({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    taskName: taskTarget.name,
    taskRunId: childRun.id,
    taskInput: childRun.input ?? input.run.input,
    idempotencyKey: childRun.idempotencyKey,
    timeout: taskDeclaration?.timeout ?? taskTarget.timeout,
  })
}

function unsupportedParallelCase(
  nodeName: string,
  member: WorkflowCaseImplementation,
): Error {
  return new Error(
    `Unsupported parallel ${member.kind} member [${member.name}] in node [${nodeName}]`,
  )
}
