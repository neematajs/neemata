import type { ContinueRun, StoredError, StoredRun } from '../model.ts'
import type {
  DurableProgram,
  History,
  Operation,
  ReplayOutcome,
} from '../program.ts'
import type { ReadScope } from '../store.ts'
import type { Draft } from './draft.ts'
import { continueRun, isTerminal, SELF } from '../model.ts'
import { revisionKey } from './definitions.ts'
import { finishRun, stopWork } from './finish.ts'
import { canonical } from './keys.ts'
import { observe, start } from './pass.ts'

/**
 * How many times one pass replays a body. A replay that opens a node done at
 * once, the time observed or a sleep already over, is followed by another
 * that reads it; a body that keeps asking for such nodes is cut off here and
 * goes on in the next pass.
 */
const REPLAYS_PER_PASS = 64

/**
 * What a pass of a durable run reads: the run opened, and the definitions of
 * its revision and of everything its body may start, so a pass that starts a
 * run does not plan twice for want of them.
 */
export function durableScope(
  program: DurableProgram,
  command: ContinueRun,
): ReadScope {
  const { runId, name, revision } = command
  const keys = new Set<string>()
  if (revision !== undefined) {
    keys.add(revisionKey({ kind: 'workflow', name, revision }))
  }
  for (const { definition } of program.references) {
    for (const { key } of definition?.records ?? []) keys.add(key)
  }
  return {
    open: [{ runId, maps: [], linked: true }],
    definitions: Array.from(keys),
  }
}

/**
 * One pass of a durable run: settles the nodes whose work has ended, replays
 * the body against what is stored, and opens the nodes it asks for that the
 * run has none of. The body is replayed whole each time; a node is the only
 * thing that carries what happened from one pass to the next.
 *
 * A body that has its outcome ends the run once the nodes it left behind,
 * branches it no longer waits for, have been stopped: until then the run
 * keeps its unique key, as a run being cancelled does.
 */
export function advanceDurable(
  draft: Draft,
  program: DurableProgram,
  run: StoredRun,
): readonly StoredRun[] {
  settle(draft, run)
  // Blocked for a mismatch, the run opens nothing until an operator resumes
  // it, whatever code is deployed by then: its work settles meanwhile.
  if (run.error?.name === MISMATCH) return []

  let blocked: readonly string[] = []
  for (let replay = 1; ; replay++) {
    const replayed = program.replay(history(draft, run))
    const { outcome, operations } = replayed
    // Checked before anything is written: a body that no longer asks what
    // its run was opened with must not start anything on that reading. The
    // run waits for code that replays it as it was, and for a resume.
    const mismatch = diverged(draft, run, operations)
    if (mismatch) return block(draft, run, mismatch)
    if (outcome._tag !== 'Suspended') return conclude(draft, run, outcome)
    blocked = replayed.blocked

    // A node of the run found cancelled was cancelled from outside, as a
    // child run of it can be: the run is cancelled with it, as a workflow
    // whose step was is.
    if (draft.nodes(run.id).some(({ status }) => status === 'cancelled')) {
      const cancelling = draft.updateRun(run, { status: 'cancelling' })
      draft.enqueue(continueRun(cancelling))
      return []
    }

    let ordinal = draft.nodes(run.id).length
    let done = false
    for (const operation of operations) {
      if (draft.nodeRead(run.id, operation.name)) continue
      done = open(draft, run, operation, ordinal++) || done
    }
    // Nothing opened was done at once: another replay would ask the same.
    if (!done) break
    if (replay >= REPLAYS_PER_PASS) {
      // The body goes on past what this pass opened in the next one.
      draft.enqueue(continueRun(run))
      break
    }
  }

  // Blocked once, a node keeps it while the body waits on it, whatever the
  // code says of failures since. One the body no longer waits on, a branch
  // it let go of, blocks nothing and is let go of too. Every change writes
  // the run, so the version an operator read says whether it still holds.
  let blocking = false
  const waitedOn = new Set(blocked)
  for (const name of blocked) {
    const node = draft.node(run.id, name)!
    if (node.operation?.blocked) continue
    draft.updateNode(node, { operation: { ...node.operation!, blocked: true } })
    blocking = true
  }
  for (const read of draft.nodes(run.id)) {
    if (!read.operation?.blocked || waitedOn.has(read.name)) continue
    const node = draft.node(run.id, read.name)!
    const { blocked: _, ...operation } = node.operation!
    draft.updateNode(node, { operation })
    blocking = true
  }

  wakeAtNextDeadline(draft, run)
  const nodes = draft.nodes(run.id)
  const status = nodes.some(({ operation }) => operation?.blocked)
    ? 'blocked'
    : nodes.some(({ status }) => status === 'running')
      ? 'running'
      : 'waiting'
  const head = draft.head(run.id)!
  if (head.status !== status || blocking) draft.updateRun(head, { status })
  return []
}

/** The name of the error a run blocked for a replay mismatch holds. */
export const MISMATCH = 'ReplayMismatch'

/**
 * Blocks a run whose replay no longer asks what it stored: nothing is
 * opened or ended, its other work settles as it does, and it waits for code
 * that replays it as it was and a `Client.resume`, which replays it again.
 */
function block(
  draft: Draft,
  run: StoredRun,
  error: StoredError,
): readonly StoredRun[] {
  draft.updateRun(draft.head(run.id)!, { status: 'blocked', error })
  return []
}

/** A run's history as a replay reads it: what the pass has, its own writes too. */
function history(draft: Draft, run: StoredRun): History {
  return {
    input: run.input,
    node: (name) => draft.nodeRead(run.id, name)?.record,
  }
}

/**
 * Settles the nodes whose work has ended since the last pass: a task or
 * workflow node once its child run has, a sleep once its time has come, and
 * an input whose value did not come before its time did.
 */
function settle(draft: Draft, run: StoredRun) {
  const open = draft
    .nodes(run.id)
    .filter(({ status }) => !isTerminal(status) && status !== 'cancelling')
  const children = open.flatMap(({ name, kind }) => {
    if (kind !== 'task' && kind !== 'workflow') return []
    const child = draft.child(run.id, name, SELF)
    return child ? [child] : []
  })
  draft.require({
    heads: children.flatMap(({ status, childRunId }) =>
      isTerminal(status) || childRunId === undefined ? [] : [childRunId],
    ),
  })

  for (const child of children) {
    const observed = observe(draft, child)
    if (!isTerminal(observed.status)) continue
    const node = draft.node(run.id, child.nodeName)!
    if (observed.status === 'completed') {
      draft.updateNode(node, { status: 'completed', output: observed.output })
    } else if (observed.status === 'failed') {
      const error = observed.error ?? {
        message: `Durable operation [${node.name}] failed`,
      }
      draft.updateNode(node, { status: 'failed', error })
    } else draft.updateNode(node, { status: 'cancelled' })
  }

  for (const read of open) {
    const { operation } = read
    const until = operation?.until
    if (until === undefined || until > draft.now) continue
    const node = draft.node(run.id, read.name)!
    if (read.kind === 'sleep') {
      draft.updateNode(node, { status: 'completed', output: null })
    } else if (read.kind === 'input') {
      // A value sent before its time completed the node then: one still
      // waiting has none, whenever the pass that finds it runs.
      draft.updateNode(node, {
        status: 'completed',
        output: null,
        operation: { ...operation!, timedOut: true },
      })
    }
  }
}

const label = (run: StoredRun, name: string) => `[${name}] of run [${run.id}]`

/**
 * Why the operations a replay came to are not what the run's nodes were
 * opened with; `undefined` when they are. A name is one operation for the
 * whole run: asked for twice, or for something else than its node holds, it
 * is a replay that diverged, and what its node holds is never changed to fit.
 */
function diverged(
  draft: Draft,
  run: StoredRun,
  operations: readonly Operation[],
): StoredError | undefined {
  const error = (message: string): StoredError => ({
    name: MISMATCH,
    message,
  })
  const seen = new Set<string>()
  for (const operation of operations) {
    const { name } = operation
    if (seen.has(name)) {
      return error(
        `Durable operation ${label(run, name)} is asked for more than once: every operation needs a name of its own`,
      )
    }
    seen.add(name)

    const read = draft.nodeRead(run.id, name)?.record
    if (!read) continue
    if (read.kind !== operation.kind) {
      return error(
        `Durable operation ${label(run, name)} was opened as a ${read.kind} and is now asked for as a ${operation.kind}`,
      )
    }
    if (operation.kind !== 'task' && operation.kind !== 'workflow') continue

    const target =
      operation.kind === 'task' ? operation.task : operation.workflow
    const opened = read.operation?.target
    if (opened?.name !== target.name || opened.revision !== target.revision) {
      return error(
        `Durable operation ${label(run, name)} was opened for another ${operation.kind} than it is now asked for`,
      )
    }
    const node = draft.node(run.id, name)!
    if (canonical(node.input ?? null) !== canonical(operation.input ?? null)) {
      return error(
        `Durable operation ${label(run, name)} is asked for with another input than it was opened with`,
      )
    }
  }
  return undefined
}

/**
 * Opens the node an operation asks for, and starts its work. Answers whether
 * the node is done at once, so the body can be replayed past it.
 */
function open(
  draft: Draft,
  run: StoredRun,
  operation: Operation,
  ordinal: number,
): boolean {
  const base = { runId: run.id, name: operation.name, kind: operation.kind }

  switch (operation.kind) {
    case 'input': {
      const { family, key, timeoutMs } = operation
      draft.createNode({
        ...base,
        status: 'waiting',
        operation: {
          ordinal,
          input: { family, key },
          ...(timeoutMs === undefined
            ? {}
            : { until: draft.now + Math.max(0, timeoutMs) }),
        },
      })
      return false
    }
    case 'now':
      draft.createNode({
        ...base,
        status: 'completed',
        output: draft.now,
        operation: { ordinal },
      })
      return true
    case 'sleep': {
      const until = draft.now + Math.max(0, operation.durationMs)
      const over = until <= draft.now
      draft.createNode({
        ...base,
        status: over ? 'completed' : 'waiting',
        ...(over ? { output: null } : {}),
        operation: { ordinal, until },
      })
      return over
    }
    case 'task':
    case 'workflow': {
      const reference =
        operation.kind === 'task' ? operation.task : operation.workflow
      const { name, revision } = reference
      const node = draft.createNode({
        ...base,
        status: 'running',
        input: operation.input,
        operation: {
          ordinal,
          target: { name, ...(revision === undefined ? {} : { revision }) },
          ...(operation.kind === 'task' &&
          (operation.retry !== undefined || operation.timeout !== undefined)
            ? {
                limits: {
                  ...(operation.retry === undefined
                    ? {}
                    : { retry: operation.retry }),
                  ...(operation.timeout === undefined
                    ? {}
                    : { timeout: operation.timeout }),
                },
              }
            : {}),
        },
      })
      const target =
        operation.kind === 'task'
          ? {
              kind: 'task' as const,
              task: operation.task,
              ...(operation.retry === undefined
                ? {}
                : { retry: operation.retry }),
              ...(operation.timeout === undefined
                ? {}
                : { timeout: operation.timeout }),
            }
          : {
              kind: 'workflow' as const,
              workflow: operation.workflow,
              ...(operation.cancellation === undefined
                ? {}
                : { cancellation: operation.cancellation }),
            }
      start(
        draft,
        run,
        node,
        { childKey: SELF, target, input: () => operation.input },
        undefined,
        true,
      )
      // Its child waits on the run it started.
      draft.updateNode(draft.node(run.id, node.name)!, { status: 'waiting' })
      return false
    }
  }
}

/**
 * Ends a run whose body has its outcome, once nothing it started is left:
 * the nodes still open are branches the body no longer waits for, stopped
 * here, and the run waits for them as a cancelled one does, keeping its key.
 * Each pass until then replays the body to the same outcome.
 */
function conclude(
  draft: Draft,
  run: StoredRun,
  outcome: Exclude<ReplayOutcome, { readonly _tag: 'Suspended' }>,
): readonly StoredRun[] {
  const { ended, tasks } = stopWork(draft, run)
  if (!ended) return tasks
  if (outcome._tag === 'Completed') {
    finishRun(draft, run, { status: 'completed', output: outcome.output })
  } else {
    finishRun(draft, run, { status: 'failed', error: outcome.error })
  }
  return tasks
}

/**
 * Queues the pass that wakes the run at its nearest deadline: a sleep that
 * ends, an input that stops being waited for. A wake that comes earlier,
 * for anything else, queues it again from its own pass.
 */
function wakeAtNextDeadline(draft: Draft, run: StoredRun) {
  let next: number | undefined
  for (const node of draft.nodes(run.id)) {
    const until = node.operation?.until
    if (node.status !== 'waiting') continue
    if (until !== undefined && (next === undefined || until < next)) {
      next = until
    }
  }
  if (next !== undefined) draft.enqueue(continueRun(run), next)
}
