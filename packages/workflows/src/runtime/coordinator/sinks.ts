import type { RuntimeDeps } from '../executors.ts'
import type { StoredRun } from '../state.ts'
import type { AdvanceCtx, AdvanceOutcome } from './context.ts'
import { wakeParentRun } from '../wake.ts'
import { cancelRunTree } from './cancel.ts'

export async function completeRunAndWakeParent(
  deps: RuntimeDeps,
  params: { readonly runId: string; readonly output: unknown },
) {
  const completed = await deps.store.completeRun(params)
  await wakeParentRun(deps, completed)
}

export async function failRunAndWakeParent(
  deps: RuntimeDeps,
  params: { readonly runId: string; readonly error: unknown },
) {
  const failed = await deps.store.failRun(params)
  await wakeParentRun(deps, failed)
}

export async function cancelRunAndWakeParent(
  deps: RuntimeDeps,
  runId: string,
): Promise<StoredRun | undefined> {
  const cancelled = await cancelRunTree(deps, runId)
  await wakeParentRun(deps, cancelled)
  return cancelled
}

export async function failNodeAndRun(
  deps: RuntimeDeps,
  params: {
    readonly runId: string
    readonly nodeName: string
    readonly error: unknown
  },
) {
  await deps.store.failNode(params)
  await failRunAndWakeParent(deps, {
    runId: params.runId,
    error: params.error,
  })
}

export async function cancelNodeAndRun(
  deps: RuntimeDeps,
  params: { readonly runId: string; readonly nodeName: string },
) {
  await deps.store.cancelNode(params)
  await cancelRunAndWakeParent(deps, params.runId)
}

export async function failMissingChildRun(
  deps: RuntimeDeps,
  params: {
    readonly parentRunId: string
    readonly nodeName: string
    readonly childKind: 'task' | 'workflow'
    readonly childRunId: string
  },
) {
  const error = new Error(
    `Missing child ${params.childKind} run [${params.childRunId}]`,
  )
  await failNodeAndRun(deps, {
    runId: params.parentRunId,
    nodeName: params.nodeName,
    error,
  })
}

export async function completeNodeAndAdvance(
  ctx: AdvanceCtx,
  nodeName: string,
  output: unknown,
): Promise<AdvanceOutcome> {
  await ctx.store.completeNode({ runId: ctx.run.id, nodeName, output })
  return await ctx.advance({
    ...ctx,
    outputs: { ...ctx.outputs, [nodeName]: output },
  })
}
