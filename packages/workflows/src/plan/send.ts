import type { RunUnique, Timestamp } from '../model.ts'
import type { Plan, ReadScope } from '../store.ts'
import { InputRefused } from '../errors.ts'
import { continueRun, isTerminal } from '../model.ts'
import { planning, Refused } from './draft.ts'
import { canonical, uniqueKey } from './keys.ts'

/**
 * What starts the names of the nodes the engine names itself, as it does
 * inputs: a body's operations never start with it, so a name a sender picks
 * never lands on one of them.
 */
export const ENGINE = '@'

/**
 * The name of an input's node in a run: its family and its key. A family
 * holds no colon, so the first one ends it, whatever the key holds.
 */
export const inputName = (family: string, key: string) =>
  `${ENGINE}${family}:${key}`

/** A unique key as a sender names it: `active` when no scope is given. */
export type HeldKey = Pick<RunUnique, 'key'> & Partial<Pick<RunUnique, 'scope'>>

/** The run an input is sent to: by its id, or by the unique key it holds. */
export type Recipient =
  | { readonly runId: string }
  | { readonly unique: HeldKey }

/** The key of a revision among a send's encoders; the unversioned lane's. */
export const revisionOf = (revision: string | undefined) =>
  revision === undefined ? '' : `@${revision}`

export type SendInput = {
  /** The durable workflow the input is declared on, by name. */
  readonly name: string
  readonly to: Recipient
  readonly family: string
  readonly key: string
  /**
   * How the family's value is encoded for a run of each revision the sender
   * holds, by `revisionOf`: the run's own revision decides. Called in the
   * plan, which may run more than once, so it must be pure: synchronous,
   * deterministic, and without effects on the value.
   */
  readonly encode: Readonly<Record<string, (value: unknown) => unknown>>
  /** As the sender holds it; encoded for the run it reaches. */
  readonly value: unknown
}

/** An input taken: when it was received, and whether this send repeated it. */
export type Receipt = {
  readonly runId: string
  readonly input: string
  readonly receivedAt: Timestamp
  /** The same value was received before: nothing was written. */
  readonly duplicate: boolean
}

const keyOf = ({ key, scope = 'active' }: HeldKey) => uniqueKey({ key, scope })

/** The run named, opened; or the key, and the run holding it when asked. */
export function sendScope({ to }: SendInput): ReadScope {
  if ('runId' in to) {
    return { open: [{ runId: to.runId, maps: [], linked: false }] }
  }
  return { keys: [keyOf(to.unique)] }
}

/**
 * Takes an input for a durable run, in one commit with the caller's writes
 * when it is in their transaction. A value sent before the run comes to its
 * input is kept until it does; one sent while the run waits completes the
 * wait and wakes the run. The first value of an input is its value: the
 * same one sent again is answered with its receipt, another is refused.
 */
export function planSend(input: SendInput): Plan<Receipt, InputRefused> {
  const { name: workflow, to, family, key, encode } = input
  const name = inputName(family, key)

  return planning<Receipt, InputRefused>((draft) => {
    const refuse = (
      reason: InputRefused['reason'],
      runId?: string,
      found?: InputRefused['found'],
    ) =>
      new Refused(
        new InputRefused({
          reason,
          input: name,
          ...(runId === undefined ? {} : { runId }),
          ...(found === undefined ? {} : { found }),
        }),
      )

    const runId = 'runId' in to ? to.runId : draft.holder(keyOf(to.unique))
    if (runId === undefined) return refuse('missing')
    const run = draft.head(runId)
    if (!run) return refuse('missing', runId)
    // A task may share the workflow's name and revision: it is another run.
    // Of the workflow, a run of a revision the sender holds no schema of is
    // another one too: only that revision's schema may encode for it.
    const encoder = Object.hasOwn(encode, revisionOf(run.revision))
      ? encode[revisionOf(run.revision)]
      : undefined
    if (run.kind !== 'workflow' || run.name !== workflow || !encoder) {
      const { kind, name: found, revision } = run
      return refuse('other', runId, {
        kind,
        name: found,
        ...(revision === undefined ? {} : { revision }),
      })
    }
    // The run's nodes are what decide, so they are read with it.
    draft.nodes(runId)
    // Encoded for this run, by its revision: a value its schema refuses is
    // a defect, and nothing is written.
    const value = encoder(input.value)

    const node = draft.nodeRead(runId, name)?.record
    // A body cannot name an operation so: one stored is a store gone wrong.
    if (node && node.kind !== 'input') {
      throw new Error(
        `Node [${name}] of run [${runId}] has an input's name and is a ${node.kind}`,
      )
    }
    const receivedAt = node?.operation?.receivedAt
    if (node?.status === 'completed') {
      if (node.operation?.timedOut) return refuse('closed', runId)
      // Read whole for its value only when it may be the same one.
      const stored = draft.node(runId, name)!
      if (
        receivedAt !== undefined &&
        canonical(stored.output ?? null) === canonical(value ?? null)
      ) {
        return { runId, input: name, receivedAt, duplicate: true }
      }
      return refuse('received', runId)
    }
    if (isTerminal(run.status) || run.status === 'cancelling') {
      return refuse('ended', runId)
    }

    if (node) {
      // The run waits on it: past its time, it waits no more, even before a
      // pass has found so.
      const until = node.operation?.until
      if (
        node.status !== 'waiting' ||
        (until !== undefined && until <= draft.now)
      ) {
        return refuse('closed', runId)
      }
      const stored = draft.node(runId, name)!
      draft.updateNode(stored, {
        status: 'completed',
        output: value,
        operation: { ...stored.operation!, receivedAt: draft.now },
      })
      draft.enqueue(continueRun(run))
    } else {
      // Kept until the run comes to it, in the order the run took it in.
      draft.createNode({
        runId,
        name,
        kind: 'input',
        status: 'completed',
        output: value,
        operation: {
          ordinal: draft.nodes(runId).length,
          input: { family, key },
          receivedAt: draft.now,
        },
      })
    }
    return { runId, input: name, receivedAt: draft.now, duplicate: false }
  })
}
