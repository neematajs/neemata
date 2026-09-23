import type {
  StoredAttempt,
  StoredNode,
  StoredNodeChild,
  StoredRun,
} from '../../runtime/state.ts'
import type {
  WorkflowCommandWakeKind,
  WorkflowWakeEvents,
} from '../../runtime/wake-events.ts'

export function createWakeEvents(runs: Map<string, StoredRun>) {
  const commands = new Map<WorkflowCommandWakeKind, Set<() => void>>()
  const cancellations = new Map<string, Set<() => void>>()
  const runEvents = new Map<string, Set<() => void>>()

  // Wake hints carry no persisted event payload; watchers re-read shared state.
  function runStatus(run: StoredRun) {
    fireWake(runEvents.get(run.rootRunId))
  }

  function statusChange(
    before: StoredNode | StoredNodeChild | StoredAttempt | undefined,
    after: StoredNode | StoredNodeChild | StoredAttempt,
  ) {
    if (before?.status === after.status) return
    fireWake(runEvents.get(runs.get(after.runId)?.rootRunId ?? after.runId))
  }

  function command(kind: WorkflowCommandWakeKind) {
    fireWake(commands.get(kind))
  }

  function cancellation(runId: string) {
    fireWake(cancellations.get(runId))
  }

  const events: WorkflowWakeEvents = {
    onCommand(kind, listener) {
      return subscribeWake(commands, kind, listener)
    },
    onCancellation(runId, listener) {
      return subscribeWake(cancellations, runId, listener)
    },
    onRunEvent(rootRunId, listener) {
      return subscribeWake(runEvents, rootRunId, listener)
    },
    dispose() {
      commands.clear()
      cancellations.clear()
      runEvents.clear()
    },
  }

  return {
    events,
    command,
    cancellation,
    runStatus,
    statusChange,
  }
}

function subscribeWake<K>(
  listeners: Map<K, Set<() => void>>,
  key: K,
  listener: () => void,
) {
  const set = listeners.get(key) ?? new Set<() => void>()
  listeners.set(key, set)
  set.add(listener)
  function unsubscribe() {
    set.delete(listener)
    if (set.size === 0) listeners.delete(key)
  }

  return unsubscribe
}

function fireWake(listeners: Set<() => void> | undefined) {
  if (!listeners) return
  for (const listener of listeners) listener()
}
