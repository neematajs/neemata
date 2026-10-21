import type {
  ContinueRun,
  NodeKind,
  StoredChild,
  StoredNode,
  StoredRun,
} from '../model.ts'
import type {
  Outputs,
  Registry,
  Selected,
  Step,
  Target,
  WorkflowProgram,
} from '../program.ts'
import type {
  Claim,
  MapRead,
  NodeWithoutInput,
  Plan,
  ReadScope,
} from '../store.ts'
import type { Unroutable } from './begin.ts'
import type { Draft } from './draft.ts'
import { DefinitionConflict } from '../errors.ts'
import {
  caseKey,
  continueRun,
  isTerminal,
  itemKey,
  memberKey,
  SELF,
  STATUSES,
  storedError,
} from '../model.ts'
import { isDurable } from '../program.ts'
import {
  conflicting,
  described,
  drift,
  durableGraph,
  graphKey,
  revisionKey,
  save,
} from './definitions.ts'
import { planning, Unwritten } from './draft.ts'
import { advanceDurable, durableScope } from './durable.ts'
import { cancelRun, draining, finishRun, wakeParent } from './finish.ts'
import { canonical } from './keys.ts'
import { reattempt, reopenRun, reopenWork } from './retry.ts'
import { startTask } from './task.ts'

export type PassResult =
  | {
      readonly _tag: 'Advanced'
      /**
       * Left `cancelling`, waiting for work only a drain may end when
       * nothing holds it any more: the run, and task runs under it.
       */
      readonly draining?: readonly StoredRun[]
    }
  /** The run is gone; the command was dropped. */
  | { readonly _tag: 'Ignored' }
  | Unroutable

type MapStep = Extract<Step, { readonly kind: 'map' }>

/** How many of a map's waiting children a pass reads: as many as may run. */
const windowOf = (step: MapStep): MapRead['pendingLimit'] =>
  step.concurrency ?? 'all'

/**
 * What a pass of the command's run reads: the run opened, with a window on
 * each map its program has. The definitions are known before the run is:
 * its revision's manifest, to check the registered program against, and
 * whatever the runs its steps start bring. Loading them with the run keeps
 * a pass that starts children from being planned twice.
 */
export function passScope(registry: Registry, command: ContinueRun): ReadScope {
  const program = registry.workflow(command)
  if (program && isDurable(program)) return durableScope(program, command)
  const { runId, name, revision } = command
  const keys = new Set<string>()
  if (revision !== undefined) {
    keys.add(revisionKey({ kind: 'workflow', name, revision }))
  }
  const maps: MapRead[] = []
  // Code that starts no runs has no child a run stands for, unless code
  // deployed before it did: a pass asks for the runs of any it finds.
  let linked = false
  for (const step of program?.steps ?? []) {
    if (step.kind === 'map') {
      maps.push({ nodeName: step.name, pendingLimit: windowOf(step) })
    }
    for (const target of targets(step)) {
      const route = reference(target)
      if (route) linked = true
      for (const { key } of route?.definition?.records ?? []) keys.add(key)
    }
  }
  return { open: [{ runId, maps, linked }], definitions: Array.from(keys) }
}

/**
 * One coordination pass: everything that can be decided about a run from what
 * is stored now, in one commit with the acknowledgement of its command.
 *
 * It decides from the run opened: what is under way, and what may start
 * next. Cancelling and reopening read the run whole, and have it loaded so
 * when they come to it.
 */
export function planPass(
  registry: Registry,
  claim: Claim<ContinueRun>,
): Plan<PassResult> {
  const { command } = claim

  return planning<PassResult>((draft) => {
    const run = draft.head(command.runId)
    if (!run) {
      draft.ack(claim)
      return { _tag: 'Ignored' }
    }

    // The command's route only brought it here; the run is the authority.
    if (run.name !== command.name || run.revision !== command.revision) {
      return { _tag: 'Unroutable' }
    }

    // Task runs a durable run's body let go of, waiting for their handlers.
    let stopped: readonly StoredRun[] = []
    if (run.status === 'cancelling') {
      cancelRun(draft, run)
    } else if (isTerminal(run.status)) {
      // Waking is repeated on purpose: it is how a parent learns of an
      // outcome whose first wake it had no pass left to read.
      wakeParent(draft, run)
    } else if (run.kind === 'workflow') {
      // Only a workflow run is advanced: a task run's attempt settles it.
      const program = registry.workflow(run)
      if (!program) return { _tag: 'Unroutable' }
      // Cancelling and waking above need no code of the run; advancing it
      // takes the code it was created with.
      const error = drift(draft, run, program.definition)
      if (error) return { _tag: 'Unroutable', error }
      // A new run owns nothing yet, so this finds work only in a run that a
      // retry made queued again.
      if (run.status === 'queued') reopenWork(draft, run)
      if (isDurable(program)) stopped = advanceDurable(draft, program, run)
      else advance(draft, program, run)
    }

    draft.ack(claim)
    const waiting = [...draining(draft, draft.head(run.id)!), ...stopped]
    return waiting.length > 0
      ? { _tag: 'Advanced', draining: waiting }
      : { _tag: 'Advanced' }
  })
}

/**
 * What driving a node answers when a child of it was found cancelled: the
 * run is cancelled, and the node with it. The node is not ended here, while
 * other children of it may be in flight: stopping reads what is in flight
 * from the nodes that have not ended.
 */
const CANCELLED = Symbol('cancelled')

function advance(draft: Draft, program: WorkflowProgram, run: StoredRun) {
  const outputs: Record<string, unknown> = Object.create(null)
  const selected: Record<string, string> = Object.create(null)
  const complete = ({ name, output, selectedCase }: NodeWithoutInput) => {
    outputs[name] = output
    if (selectedCase !== undefined) selected[name] = selectedCase
  }
  const fail = (node: NodeWithoutInput) =>
    finishRun(draft, run, {
      status: 'failed',
      error: node.error ?? { message: `Workflow node [${node.name}] failed` },
    })
  const nodes = draft.nodes(run.id)
  for (const node of nodes) if (node.status === 'completed') complete(node)
  // A failed node fails the run wherever it stands. The steps below are
  // taken in order and end the run at the first that is not completed, so
  // without this a cancelled node before it would hide the failure.
  const failed = nodes.find(({ status }) => status === 'failed')
  if (failed) return fail(failed)

  for (const step of program.steps) {
    if (Object.hasOwn(outputs, step.name)) continue

    // A map's is read without its input, the list of its items.
    const existing = draft.nodeRead(run.id, step.name)?.record
    // A pending node is one a retry found never opened: it opens again.
    const opened =
      existing && existing.status !== 'pending'
        ? existing
        : open(draft, run, step, outputs, selected, existing)
    // Already settled when it could not be opened, or when the attempt of
    // its only child settled it.
    const node = isTerminal(opened.status)
      ? opened
      : step.kind === 'map'
        ? driveMap(draft, run, step, opened, outputs, selected)
        : drive(
            draft,
            run,
            step,
            draft.node(run.id, step.name)!,
            outputs,
            selected,
          )

    if (node === CANCELLED || node.status === 'cancelled') {
      return cancelRun(draft, run)
    }
    if (node.status === 'completed') {
      complete(node)
      continue
    }
    if (node.status === 'failed') return fail(node)

    const status = node.status === 'running' ? 'running' : 'waiting'
    if (run.status !== status) draft.updateRun(run, { status })
    return
  }

  let output: unknown
  try {
    output = program.result(outputs, run.input, selected)
  } catch (error) {
    return finishRun(draft, run, {
      status: 'failed',
      error: storedError(error),
    })
  }
  return finishRun(draft, run, { status: 'completed', output })
}

function nodeKind(step: Step): NodeKind {
  if (step.kind !== 'map') return step.kind
  return step.target.kind === 'task' ? 'mapTask' : 'mapWorkflow'
}

/** What is computed once for a node, when the run reaches its step. */
function once(
  step: Step,
  outputs: Outputs,
  input: unknown,
  selected: Selected,
): Pick<StoredNode, 'input' | 'selectedCase'> {
  switch (step.kind) {
    case 'branch': {
      const selectedCase = step.select(outputs, input, selected)
      if (!Object.hasOwn(step.cases, selectedCase)) {
        throw new Error(`Unknown branch case [${step.name}.${selectedCase}]`)
      }
      return {
        selectedCase,
        input: step.cases[selectedCase]!.input(outputs, input, selected),
      }
    }
    // Each member's input is its own: one that throws fails that member only.
    case 'parallel':
      return {}
    case 'map': {
      // A program is untyped where it runs, and one child is made per item.
      const items: unknown = step.items(outputs, input, selected)
      if (!Array.isArray(items)) {
        throw new TypeError(`Map [${step.name}] needs a list of items`)
      }
      return { input: items }
    }
    default:
      return { input: step.input(outputs, input, selected) }
  }
}

/**
 * Creates a step's node, and a map's children: one per item, waiting for
 * their turn. A node whose values cannot be computed is created failed.
 */
function open(
  draft: Draft,
  run: StoredRun,
  step: Step,
  outputs: Outputs,
  selected: Selected,
  reopened: NodeWithoutInput | undefined,
): StoredNode {
  const node = { runId: run.id, name: step.name, kind: nodeKind(step) }
  // Written whole, its items with it: one reopened is read whole first.
  const stored = reopened && draft.node(run.id, step.name)!
  const put = (fields: Pick<StoredNode, 'status'> & Partial<StoredNode>) =>
    stored
      ? draft.updateNode(stored, fields)
      : draft.createNode({ ...node, ...fields })

  let computed: ReturnType<typeof once>
  try {
    computed = once(step, outputs, run.input, selected)
  } catch (error) {
    return put({ status: 'failed', error: storedError(error) })
  }

  if (step.kind === 'map') {
    const items = computed.input as readonly unknown[]
    items.forEach((item, ordinal) =>
      draft.createChild({
        runId: run.id,
        nodeName: step.name,
        childKey: itemKey(ordinal),
        kind: step.target.kind,
        status: 'pending',
        ordinal,
        item,
      }),
    )
  }
  return put({ status: 'running', ...computed })
}

function targets(step: Step): readonly Target[] {
  switch (step.kind) {
    case 'branch':
      return Object.values(step.cases)
    case 'parallel':
      return Object.values(step.members)
    case 'map':
      return [step.target]
    default:
      return [step]
  }
}

/** What the run a target starts is described by; nothing for an activity. */
function reference(target: Target) {
  if (target.kind === 'activity') return undefined
  return target.kind === 'task' ? target.task : target.workflow
}

/** The place of one child: its key, and what it runs on which input. */
export type Slot = {
  readonly childKey: string
  readonly target: Target
  /** Computed when the child starts. */
  readonly input: () => unknown
}

/** The children a node is to have, and how they make up the node. */
type Fan = {
  /** In starting order; the first failure in it is the node's error. */
  readonly slots: readonly Slot[]
  /** At most this many children are in flight. */
  readonly limit: number
  /** The node's output from its children, all completed, in slot order. */
  readonly output: (children: readonly StoredChild[]) => unknown
}

function fan(
  step: Exclude<Step, MapStep>,
  node: StoredNode,
  outputs: Outputs,
  input: unknown,
  selected: Selected,
): Fan {
  // The input of an only child was computed with its node.
  const only = (childKey: string, target: Target): Fan => ({
    slots: [{ childKey, target, input: () => node.input }],
    limit: Infinity,
    output: ([child]) => child!.output,
  })

  switch (step.kind) {
    case 'branch': {
      const key = node.selectedCase!
      return only(caseKey(key), step.cases[key]!)
    }
    case 'parallel': {
      const members = Object.entries(step.members)
      return {
        slots: members.map(([key, member]) => ({
          childKey: memberKey(key),
          target: member,
          input: () => member.input(outputs, input, selected),
        })),
        limit: Infinity,
        output: (children) => {
          const combined: Record<string, unknown> = Object.create(null)
          members.forEach(([key], index) => {
            combined[key] = children[index]!.output
          })
          return combined
        },
      }
    }
    default:
      return only(SELF, step)
  }
}

/**
 * Moves a node as far as its children allow: settles the children whose runs
 * have ended, starts those whose turn it is, and settles the node once every
 * child has settled. A failure therefore never stops a sibling; only a
 * cancelled child stops the others early, by cancelling the run.
 */
function drive(
  draft: Draft,
  run: StoredRun,
  step: Exclude<Step, MapStep>,
  node: StoredNode,
  outputs: Outputs,
  selected: Selected,
): StoredNode | typeof CANCELLED {
  const { slots, limit, output } = fan(step, node, outputs, run.input, selected)
  const child = ({ childKey }: Slot) => draft.child(run.id, node.name, childKey)
  const started = slots.flatMap((slot) => {
    const existing = child(slot)
    return existing && existing.status !== 'pending' ? [existing] : []
  })

  draft.require({
    heads: started.flatMap(({ status, childRunId }) =>
      isTerminal(status) || childRunId === undefined ? [] : [childRunId],
    ),
  })
  const observed = started.map((existing) => observe(draft, existing))
  if (observed.some(({ status }) => status === 'cancelled')) return CANCELLED

  let inFlight = observed.filter(({ status }) => !isTerminal(status)).length
  // The runs of children a retry reopened, as many as can start now.
  const resumed = slots
    .flatMap((slot) => {
      const { status, childRunId } = child(slot) ?? {}
      return status === 'pending' && childRunId !== undefined
        ? [childRunId]
        : []
    })
    .slice(0, Math.max(0, limit - inFlight))
  draft.require({ heads: resumed })
  draft.require({
    runs: resumed.filter((id) => {
      const head = draft.head(id)
      return head?.kind === 'task' && unfinished(head)
    }),
  })
  for (const slot of slots) {
    if (inFlight >= limit) break
    const existing = child(slot)
    if (existing && existing.status !== 'pending') continue
    if (start(draft, run, node, slot, existing)) inFlight += 1
  }

  // Every slot within the limit has a child by now, and so has every item.
  const children = slots.map((slot) => child(slot)!)
  if (children.every(({ status }) => isTerminal(status))) {
    const failed = children.find(({ status }) => status === 'failed')
    if (!failed) {
      return draft.updateNode(node, {
        status: 'completed',
        output: output(children),
      })
    }
    const error = failed.error ?? {
      message: `Child [${node.name}.${failed.childKey}] failed`,
    }
    return draft.updateNode(node, { status: 'failed', error })
  }

  // Running while an attempt of the run's own is out, waiting on child runs.
  const status = children.some(({ status }) => status === 'running')
    ? 'running'
    : 'waiting'
  return node.status === status ? node : draft.updateNode(node, { status })
}

/**
 * Moves a map as `drive` moves a node, from its children under way and the
 * first of those waiting: a pass reads near what may run at once, however
 * many items the map has, and builds nothing for the items it does not
 * reach. Each child starts from its own item, as it was listed when the map
 * opened.
 *
 * It ends once no child is under way and none waits, beyond the window
 * read too. Then it reads every child once: the output is them all, by
 * ordinal, or the first of them by ordinal that failed.
 */
function driveMap(
  draft: Draft,
  run: StoredRun,
  step: MapStep,
  node: NodeWithoutInput,
  outputs: Outputs,
  selected: Selected,
): NodeWithoutInput | typeof CANCELLED {
  const limit = step.concurrency ?? Infinity
  const write = (patch: Partial<NodeWithoutInput>) =>
    draft.updateNodeKeepingInput(node, patch)

  const { active } = draft.work(run.id, node.name, windowOf(step))
  draft.require({
    heads: active.flatMap(({ childRunId }) =>
      childRunId === undefined ? [] : [childRunId],
    ),
  })
  const observed = active.map((existing) => observe(draft, existing))
  if (observed.some(({ status }) => status === 'cancelled')) return CANCELLED

  let inFlight = observed.filter(({ status }) => !isTerminal(status)).length
  const { pending, pendingLimit, hasMore } = draft.work(
    run.id,
    node.name,
    windowOf(step),
  )
  // The runs of children a retry reopened, as many as can start now.
  const resumed = pending
    .flatMap(({ childRunId }) => (childRunId === undefined ? [] : [childRunId]))
    .slice(0, Math.max(0, limit - inFlight))
  draft.require({ heads: resumed })
  draft.require({
    runs: resumed.filter((id) => {
      const head = draft.head(id)
      return head?.kind === 'task' && unfinished(head)
    }),
  })
  for (const child of pending) {
    if (inFlight >= limit) break
    const slot: Slot = {
      childKey: child.childKey,
      target: step.target,
      input: () =>
        step.input(outputs, run.input, child.item, child.ordinal!, selected),
    }
    if (start(draft, run, node, slot, child)) inFlight += 1
  }
  // Every child read has started, or failed to, and there is room for more:
  // twice as many are read, and the pass is planned again on them. A pass
  // never ends while work it could start waits unread.
  if (inFlight < limit && hasMore && pendingLimit !== 'all') {
    draft.work(
      run.id,
      node.name,
      Math.min(2 * pendingLimit, Number.MAX_SAFE_INTEGER),
    )
  }

  const work = draft.work(run.id, node.name, pendingLimit)
  if (work.active.length === 0 && work.pending.length === 0 && !work.hasMore) {
    return finishMap(draft, run, node, write)
  }
  // Running while an attempt of the run's own is out, waiting on child runs.
  const status = work.active.some(({ status }) => status === 'running')
    ? 'running'
    : 'waiting'
  return node.status === status ? node : write({ status })
}

/**
 * Settles a map none of whose children is left to run, from all of them and
 * the items it opened with. A child for each item, in its place, is what
 * makes a map's output: one missing, or out of place, is a fault of what is
 * stored, never a shorter output.
 */
function finishMap(
  draft: Draft,
  run: StoredRun,
  node: NodeWithoutInput,
  write: (patch: Partial<NodeWithoutInput>) => NodeWithoutInput,
) {
  const { node: stored, children } = draft.results(run.id, node.name)!
  const items = stored.input
  const placed =
    Array.isArray(items) &&
    children.length === items.length &&
    children.every(
      ({ ordinal, childKey, item }, index) =>
        ordinal === index &&
        childKey === itemKey(index) &&
        canonical(item ?? null) === canonical(items[index] ?? null),
    )
  if (!placed) {
    throw new Error(
      `Map [${node.name}] of run [${run.id}] has children that are not its items`,
    )
  }

  // A child cancelled ends its map so wherever it is found.
  if (children.some(({ status }) => status === 'cancelled')) {
    return write({ status: 'cancelled' })
  }
  const failed = children.find(({ status }) => status === 'failed')
  if (failed) {
    const error = failed.error ?? {
      message: `Child [${node.name}.${failed.childKey}] failed`,
    }
    return write({ status: 'failed', error })
  }
  return write({
    status: STATUSES.completed,
    output: {
      items: children.map(({ item, ordinal, childRunId, output }) => ({
        item,
        index: ordinal,
        runId: childRunId,
        output,
      })),
    },
  })
}

/** Settles a child from the run it stands for, once that run has ended. */
export function observe(draft: Draft, child: StoredChild): StoredChild {
  const { childRunId } = child
  if (isTerminal(child.status) || childRunId === undefined) return child

  const childRun = draft.head(childRunId)
  if (!childRun) {
    const error = { message: `Missing child run [${childRunId}]` }
    return draft.updateChild(child, { status: 'failed', error })
  }
  if (childRun.status === 'completed') {
    const { output } = childRun
    return draft.updateChild(child, { status: 'completed', output })
  }
  if (childRun.status === 'failed') {
    const error = childRun.error ?? {
      message: `Child run [${childRunId}] failed`,
    }
    return draft.updateChild(child, { status: 'failed', error })
  }
  if (childRun.status === 'cancelled') {
    return draft.updateChild(child, { status: 'cancelled' })
  }
  return child
}

/** Ended without completing: what a retry runs again. */
const unfinished = ({ status }: StoredRun) =>
  status === 'failed' || status === 'cancelled'

/**
 * Takes up the run a reopened child stands for, where a new child would
 * start one: a run that did not complete is reopened as itself, and one that
 * did, or is still going, is observed as it is. Answers whether it is in
 * flight.
 */
function resume(draft: Draft, child: StoredChild, target: Target): boolean {
  const childRun = draft.head(child.childRunId!)
  const waiting = draft.updateChild(child, { status: 'waiting' })
  if (childRun && unfinished(childRun)) {
    reopenRun(draft, childRun, target.kind === 'task' ? target : {})
    return true
  }
  return !isTerminal(observe(draft, waiting).status)
}

/**
 * Starts the work of a slot. An input that cannot be computed fails the child
 * instead, and nothing is in flight for it: the answer says which.
 */
export function start(
  draft: Draft,
  run: StoredRun,
  node: NodeWithoutInput,
  { childKey, target, input: compute }: Slot,
  pending: StoredChild | undefined,
  /**
   * Whether the parent replays a body. Only such a parent may start a run
   * of a durable workflow: a static one retries what failed under it by
   * reopening it, which a durable run refuses.
   */
  durableParent = false,
): boolean {
  const { id: runId, name, revision } = run
  const child = { runId, nodeName: node.name, childKey }
  const attempt = (attemptId: string, input: unknown) =>
    draft.enqueue({
      kind: 'runAttempt',
      name,
      ...(revision === undefined ? {} : { revision }),
      ...child,
      attemptId,
      input,
    })

  // A child a retry reopened continues what it had: its run, or its
  // attempts on the input they were given, which is not computed again.
  if (pending?.childRunId !== undefined) return resume(draft, pending, target)
  if (pending && pending.attemptCount > 0) {
    const { id, input } = reattempt(draft, pending)
    attempt(id, input)
    return true
  }

  const put = (fields: Pick<StoredChild, 'status'> & Partial<StoredChild>) =>
    pending
      ? draft.updateChild(pending, fields)
      : draft.createChild({ ...child, kind: target.kind, ...fields })

  let input: unknown
  try {
    input = compute()
  } catch (error) {
    put({ status: 'failed', error: storedError(error) })
    return false
  }

  if (target.kind === 'activity') {
    const attemptId = draft.id('attempt')
    put({
      status: 'running',
      input,
      currentAttemptId: attemptId,
      attemptCount: 1,
    })
    draft.createAttempt({
      ...child,
      id: attemptId,
      attemptNumber: 1,
      retryAttemptNumber: 1,
      input,
    })
    attempt(attemptId, input)
    return true
  }

  const route = reference(target)!
  const records = route.definition?.records ?? []
  if (!durableParent && route.definition !== undefined) {
    const graph = graphKey(route.definition.graphHash)
    if (durableGraph(records.find(({ key }) => key === graph)?.value)) {
      throw new Unwritten<PassResult>({
        _tag: 'Unroutable',
        error: new DefinitionConflict({
          message: `Workflow run [${runId}] starts durable workflow [${route.name}] from a static step: only a durable workflow may`,
        }),
      })
    }
  }
  // The child's revision is saved as another graph or with other bindings
  // than the code here holds: the pass writes nothing, this run included.
  const error = conflicting(draft, records)
  if (error) throw new Unwritten<PassResult>({ _tag: 'Unroutable', error })
  // All of them when the parent is unversioned; none when it is pinned, as
  // its start saved everything its manifest binds.
  save(draft, records)

  const childRun = {
    id: draft.id('run'),
    name: route.name,
    ...(route.revision === undefined ? {} : { revision: route.revision }),
    ...described(route.definition),
    input,
    parentRunId: runId,
    parentNodeName: node.name,
    parentRoute: { name, ...(revision === undefined ? {} : { revision }) },
    rootRunId: run.rootRunId,
  }
  if (target.kind === 'task') {
    startTask(draft, childRun, target)
    put({ status: 'waiting', input, childRunId: childRun.id })
  } else {
    const { cancellation } = target
    draft.enqueue(
      continueRun(draft.createRun({ ...childRun, kind: 'workflow' })),
    )
    put({
      status: 'waiting',
      input,
      childRunId: childRun.id,
      ...(cancellation === undefined ? {} : { cancellation }),
    })
  }
  return true
}
