import type {
  ParallelNodeImplementation,
  WorkflowCaseImplementation,
} from '../../../implement/index.ts'
import type {
  AnyTaskDefinition,
  BranchCaseDefinition,
} from '../../../types/index.ts'
import type { NodeChildIdentity } from '../../state.ts'
import type { AdvanceCtx } from '../context.ts'
import { isTerminalNodeStatus, isTerminalRunStatus } from '../../status.ts'
import { dispatchTaskRunAttempt, dispatchActivityAttempt } from '../attempt.ts'
import { cancelNodeChildRunsAndCommands } from '../cancel.ts'
import { sameNodeChildIdentity } from '../children.ts'
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
) {
  const existing = await input.store.createNode({
    runId: input.run.id,
    name: input.node.name,
    kind: 'parallel',
  })
  if (isTerminalNodeStatus(existing.status)) return

  const children = await input.store.loadNodeChildren({
    runId: input.run.id,
    nodeName: input.node.name,
  })
  const outputs: Record<string, unknown> = {}
  const declaration = getWorkflowNodeDeclaration(
    input.workflow,
    input.node.name,
  )
  if (declaration.kind !== 'parallel') {
    throw new Error(`Workflow node [${input.node.name}] is not parallel`)
  }

  for (const [memberKey, member] of Object.entries(input.node.cases)) {
    const memberDeclaration = declaration.cases[memberKey]
    if (!memberDeclaration) {
      throw new Error(
        `Missing parallel member declaration [${input.node.name}.${memberKey}]`,
      )
    }
    const identity = {
      runId: input.run.id,
      nodeName: input.node.name,
      memberKey,
    } satisfies NodeChildIdentity

    const existingAttempt = children.attempts.find(
      (attempt) =>
        attempt.identity && sameNodeChildIdentity(attempt.identity, identity),
    )
    if (existingAttempt?.status === 'completed') {
      outputs[memberKey] = existingAttempt.output
      continue
    }
    if (existingAttempt?.status === 'failed') {
      const error =
        existingAttempt.error ??
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
      return
    }

    if (member.kind === 'workflow') {
      const existingLink = children.childLinks.find((link) =>
        sameNodeChildIdentity(link.identity, identity),
      )
      if (existingLink) {
        const snapshot = await input.store.loadRunSnapshot(
          existingLink.childRunId,
        )
        const childRun = snapshot?.run
        if (!childRun) {
          await failMissingChildRun({
            store: input.store,
            runCoordinationExecutor: input.runCoordinationExecutor,
            parentRunId: input.run.id,
            nodeName: input.node.name,
            childKind: 'workflow',
            childRunId: existingLink.childRunId,
          })
          return
        }

        if (!isTerminalRunStatus(childRun.status)) {
          await input.runCoordinationExecutor.enqueue({
            kind: 'continueRun',
            runId: existingLink.childRunId,
            workflowName: existingLink.workflowName,
          })
          continue
        }
        if (childRun.status === 'completed') {
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
          return
        }

        const error =
          childRun.error ??
          new Error(
            `Parallel child workflow [${childRun.id}] ${childRun.status}`,
          )
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
        return
      }

      const nodeInput = decodeWorkflowUserSchemaValue(
        member.target.input,
        member.input
          ? runWorkflowUserCallback(() =>
              member.input!(input.workflowCtx, input.outputs, input.run.input),
            )
          : input.run.input,
        `workflow input [${input.workflow.workflow.name}.${input.node.name}.${memberKey}]`,
      )
      const idempotencyKey = resolveIdempotency(
        member.idempotency,
        input.workflowCtx,
        input.outputs,
        input.run.input,
      )
      const child = await input.store.ensureChildWorkflowRun({
        identity,
        workflowName: member.target.name,
        input: nodeInput,
        parentRunId: input.run.id,
        parentNodeName: input.node.name,
        rootRunId: input.run.rootRunId,
        idempotencyKey,
      })
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: child.childRun.id,
        workflowName: member.target.name,
      })
      continue
    }

    if (member.kind === 'task') {
      if (memberDeclaration.kind !== 'task') {
        throw new Error(
          `Parallel member [${input.node.name}.${memberKey}] is not a task`,
        )
      }
      const taskDeclaration = memberDeclaration as BranchCaseDefinition<
        'task',
        unknown,
        unknown,
        AnyTaskDefinition
      >
      const taskTarget = member.target as AnyTaskDefinition
      const existingLink = children.childLinks.find((link) =>
        sameNodeChildIdentity(link.identity, identity),
      )
      if (existingLink) {
        const snapshot = await input.store.loadRunSnapshot(
          existingLink.childRunId,
        )
        const childRun = snapshot?.run
        if (!childRun) {
          await failMissingChildRun({
            store: input.store,
            runCoordinationExecutor: input.runCoordinationExecutor,
            parentRunId: input.run.id,
            nodeName: input.node.name,
            childKind: 'task',
            childRunId: existingLink.childRunId,
          })
          return
        }

        if (!isTerminalRunStatus(childRun.status)) {
          await dispatchTaskRunAttempt({
            store: input.store,
            attemptExecutor: input.attemptExecutor,
            runCoordinationExecutor: input.runCoordinationExecutor,
            taskName: taskTarget.name,
            taskRunId: existingLink.childRunId,
            taskInput: childRun?.input ?? input.run.input,
            idempotencyKey: childRun.idempotencyKey,
            timeout: taskDeclaration.timeout ?? taskTarget.timeout,
          })
          continue
        }
        if (childRun.status === 'completed') {
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
          return
        }

        const error =
          childRun.error ??
          new Error(`Parallel child task run [${childRun.id}] failed`)
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
        return
      }

      const nodeInput = decodeWorkflowUserSchemaValue(
        member.target.input,
        member.input
          ? runWorkflowUserCallback(() =>
              member.input!(input.workflowCtx, input.outputs, input.run.input),
            )
          : input.run.input,
        `task input [${input.workflow.workflow.name}.${input.node.name}.${memberKey}]`,
      )
      const idempotencyKey = resolveIdempotency(
        member.idempotency,
        input.workflowCtx,
        input.outputs,
        input.run.input,
      )
      const child = await input.store.ensureChildRun({
        identity,
        childKind: 'task',
        childName: taskTarget.name,
        input: nodeInput,
        parentRunId: input.run.id,
        parentNodeName: input.node.name,
        rootRunId: input.run.rootRunId,
        idempotencyKey,
      })
      await dispatchTaskRunAttempt({
        store: input.store,
        attemptExecutor: input.attemptExecutor,
        runCoordinationExecutor: input.runCoordinationExecutor,
        taskName: taskTarget.name,
        taskRunId: child.childRun.id,
        taskInput: nodeInput,
        idempotencyKey,
        timeout: taskDeclaration.timeout ?? taskTarget.timeout,
      })
      continue
    }

    if (member.kind !== 'activity') {
      throw unsupportedParallelCase(input.node.name, member)
    }

    if (memberDeclaration.kind !== 'activity') {
      throw new Error(
        `Parallel member [${input.node.name}.${memberKey}] is not an activity`,
      )
    }
    const activityMemberDeclaration =
      memberDeclaration as BranchCaseDefinition<'activity'>
    const nodeInput = existingAttempt
      ? existingAttempt.input
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
    const idempotencyKey =
      existingAttempt?.idempotencyKey ??
      resolveIdempotency(
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
      prepareAttempt: async () => {
        const result = await input.store.ensureNodeAttempt({
          identity,
          kind: 'activity',
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
  }

  const expectedCount = Object.keys(input.node.cases).length
  if (Object.keys(outputs).length === expectedCount) {
    await input.store.completeNode({
      runId: input.run.id,
      nodeName: input.node.name,
      output: outputs,
    })
    await input.advance({
      ...input,
      outputs: { ...input.outputs, [input.node.name]: outputs },
    })
    return
  }

  await input.store.waitNode({
    runId: input.run.id,
    nodeName: input.node.name,
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
