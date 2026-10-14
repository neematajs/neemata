import type { DefinitionConflict } from '../errors.ts'
import type {
  Route,
  RunKind,
  RunUnique,
  StoredRun,
  Timestamp,
} from '../model.ts'
import type { Described } from '../program.ts'
import type { ReadScope, Plan } from '../store.ts'
import type { Draft } from './draft.ts'
import { IdempotencyConflict, RunConflict } from '../errors.ts'
import { continueRun } from '../model.ts'
import { conflicting, described, save } from './definitions.ts'
import { planning, Refused } from './draft.ts'
import { canonical, idempotencyKey, uniqueKey } from './keys.ts'
import { startTask } from './task.ts'

export type StartInput = Route & {
  /** What the route names; a workflow when omitted. */
  readonly kind?: RunKind
  /**
   * The description of the program the route names. Its records are saved
   * with the run; without one the run names no graph and nothing is saved.
   */
  readonly definition?: Described
  readonly input: unknown
  readonly tags?: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
  readonly unique?: Pick<RunUnique, 'key'> & Partial<RunUnique>
  /**
   * What starts the run, a workflow's first pass or a task's first attempt,
   * is not delivered before this time.
   */
  readonly startAt?: Timestamp
}

export type Started = {
  readonly run: StoredRun
  /** False when an existing run answered the start. */
  readonly created: boolean
}

export type StartError = DefinitionConflict | IdempotencyConflict | RunConflict

function resolveUnique(unique: StartInput['unique']): RunUnique | undefined {
  if (!unique) return undefined
  const { key, scope = 'active', behavior = 'reject' } = unique
  return { key, scope, behavior }
}

export function startScope(input: StartInput): ReadScope {
  const unique = resolveUnique(input.unique)
  return {
    keys: [
      ...(input.idempotencyKey ? [idempotencyKey(input.idempotencyKey)] : []),
      ...(unique ? [uniqueKey(unique)] : []),
    ],
    definitions: (input.definition?.records ?? []).map(({ key }) => key),
  }
}

/**
 * Creates a root run with the keys it holds and what starts it: a workflow's
 * first pass or a task's first attempt. Its keys were seen free.
 */
export function createRoot(
  draft: Draft,
  root: Route &
    Pick<StoredRun, 'kind' | 'input' | 'graphHash' | 'presentation'> &
    Partial<Pick<StoredRun, 'tags' | 'idempotencyKey' | 'unique'>> &
    Pick<StartInput, 'startAt'>,
): StoredRun {
  const { startAt, kind, graphHash, presentation, ...rest } = root
  const { idempotencyKey: idempotency, unique } = root
  const id = draft.id('run')
  const fields = {
    ...rest,
    id,
    rootRunId: id,
    ...(graphHash === undefined ? {} : { graphHash }),
    ...(presentation === undefined ? {} : { presentation }),
  }
  if (idempotency) draft.acquire(idempotencyKey(idempotency), id)
  if (unique) draft.acquire(uniqueKey(unique), id)

  if (kind === 'task') return startTask(draft, fields, { startAt })
  const run = draft.createRun({ ...fields, kind })
  draft.enqueue(continueRun(run), startAt)
  return run
}

export function planStart(input: StartInput): Plan<Started, StartError> {
  const { kind = 'workflow', name, revision, definition } = input
  const unique = resolveUnique(input.unique)
  const records = definition?.records ?? []
  const sameRunnable = (run: StoredRun) =>
    run.kind === kind && run.name === name && run.revision === revision

  return planning<Started, StartError>((draft) => {
    // A definition changed under a saved revision starts nothing, not even
    // as the replay of a request that once did.
    const conflict = conflicting(draft, records)
    if (conflict) return new Refused(conflict)

    const idempotency =
      input.idempotencyKey && idempotencyKey(input.idempotencyKey)
    if (idempotency !== undefined) {
      const holderId = draft.holder(idempotency)
      const holder = holderId === undefined ? undefined : draft.head(holderId)
      if (holder) {
        // The key names one request: the same request again is answered with
        // its run, anything else under the key is a caller's mistake.
        const replay =
          sameRunnable(holder) &&
          canonical(holder.input) === canonical(input.input)
        return replay
          ? { run: holder, created: false }
          : new Refused(new IdempotencyConflict({ name, runId: holder.id }))
      }
    }

    const uniqueness = unique && uniqueKey(unique)
    if (unique && uniqueness !== undefined) {
      const holderId = draft.holder(uniqueness)
      // An `active` key is released in the commit that ends its run, so a
      // key that is held is held by a run that counts.
      const holder = holderId === undefined ? undefined : draft.head(holderId)
      if (holder) {
        const joining = unique.behavior === 'join'
        // Two unversioned runs join whatever they are. Once either side is
        // pinned, joining must hand the caller a run of the contract it
        // asked for, never one that merely shares the key.
        const unpinned = holder.revision === undefined && revision === undefined
        if (joining && (unpinned || sameRunnable(holder))) {
          return { run: holder, created: false }
        }
        const { id: runId, status } = holder
        const { key, scope } = unique
        return new Refused(
          new RunConflict({
            runId,
            status,
            key,
            scope,
            ...(joining
              ? {
                  holder: {
                    kind: holder.kind,
                    name: holder.name,
                    ...(holder.revision === undefined
                      ? {}
                      : { revision: holder.revision }),
                  },
                }
              : {}),
          }),
        )
      }
    }

    save(draft, records)
    const run = createRoot(draft, {
      kind,
      name,
      ...(revision === undefined ? {} : { revision }),
      ...described(definition),
      input: input.input,
      ...(input.tags === undefined ? {} : { tags: input.tags }),
      ...(input.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: input.idempotencyKey }),
      ...(unique === undefined ? {} : { unique }),
      ...(input.startAt === undefined ? {} : { startAt: input.startAt }),
    })
    return { run, created: true }
  })
}
