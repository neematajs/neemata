import * as Data from 'effect/Data'

import type {
  RunKind,
  RunStatus,
  RunUniqueScope,
  StoredError,
} from './model.ts'

/**
 * The command claim a mutation acknowledges is no longer held: another
 * delivery owns the command now, and nothing of the mutation was applied.
 */
export class StaleClaim extends Data.TaggedError('StaleClaim')<{
  readonly commandId: string
}> {
  override get message() {
    return `The claim of workflow command [${this.commandId}] is no longer held`
  }
}

/**
 * The storage failed an operation of the store. Nothing of the operation was
 * applied, unless it failed while committing: then all of it was applied or
 * none of it, and which is not known.
 */
export class StorageError extends Data.TaggedError('StorageError')<{
  readonly cause: unknown
}> {
  override get message() {
    return 'Workflow storage failed'
  }
}

/** What a run is a run of. */
export type Runnable = {
  readonly kind: RunKind
  readonly name: string
  readonly revision?: string
}

/**
 * A start reused an idempotency key that names a run of another task,
 * workflow, revision or input.
 */
export class IdempotencyConflict extends Data.TaggedError(
  'IdempotencyConflict',
)<{
  /** What the refused start asked for. */
  readonly name: string
  /** The run that owns the key. */
  readonly runId: string
}> {
  override get message() {
    return `Conflicting idempotent run [${this.name}]: run [${this.runId}] owns the key`
  }
}

/** A start's unique key is held by a run it may not join. */
export class RunConflict extends Data.TaggedError('RunConflict')<{
  readonly runId: string
  readonly status: RunStatus
  readonly key: readonly unknown[]
  readonly scope: RunUniqueScope
  /**
   * Set when a `join` was refused because the run holding the key is another
   * workflow, task or revision than the one asked for: joining would hand the
   * caller a run typed by a contract it was not created with.
   */
  readonly holder?: Runnable
}> {
  override get message() {
    const { runId, scope, holder } = this
    if (holder === undefined) {
      return `Run [${runId}] already holds unique key [scope: ${scope}]`
    }
    const { kind, name, revision } = holder
    const route = revision === undefined ? name : `${name}@${revision}`
    return `Run [${runId}] of ${kind} [${route}] already holds unique key [scope: ${scope}] and cannot be joined as another workflow, task or revision`
  }
}

/**
 * A definition does not match what is saved for it: a revision whose graph or
 * child bindings differ from its saved manifest, or a graph that is not what
 * its hash names. A revision is immutable once saved, so the changed
 * definition needs a new revision.
 */
export class DefinitionConflict extends Data.TaggedError('DefinitionConflict')<{
  readonly message: string
}> {}

/** No run has this id. */
export class RunNotFound extends Data.TaggedError('RunNotFound')<{
  readonly runId: string
}> {
  override get message() {
    return `Run [${this.runId}] not found`
  }
}

/** The operation is for root runs: a child run is its parent's to redo. */
export class RunNotRoot extends Data.TaggedError('RunNotRoot')<{
  readonly runId: string
}> {
  override get message() {
    return `Run [${this.runId}] is not a root run`
  }
}

/** Only a failed run is retried in place. */
export class RunNotFailed extends Data.TaggedError('RunNotFailed')<{
  readonly runId: string
  readonly status: RunStatus
}> {
  override get message() {
    return `Run [${this.runId}] is not failed`
  }
}

/** Only a run that has ended is restarted. */
export class RunNotTerminal extends Data.TaggedError('RunNotTerminal')<{
  readonly runId: string
  readonly status: RunStatus
}> {
  override get message() {
    return `Run [${this.runId}] is not terminal`
  }
}

/** A retry named a version of the run that is no longer the stored one. */
export class StaleRunVersion extends Data.TaggedError('StaleRunVersion')<{
  readonly runId: string
  readonly expectedVersion: number
  readonly version: number
}> {
  override get message() {
    return `Stale retry version for run [${this.runId}]`
  }
}

/**
 * A retry or a deletion was refused because work of the run's family is still
 * in flight: `busyRunId` has not ended, or a worker still holds a command of
 * it. Nothing waits: ask again once it has settled.
 */
export class RunBusy extends Data.TaggedError('RunBusy')<{
  readonly runId: string
  readonly busyRunId: string
}> {
  override get message() {
    return `Run family [${this.runId}] still has active work in run [${this.busyRunId}]`
  }
}

/** No schedule has this name. */
export class UnknownSchedule extends Data.TaggedError('UnknownSchedule')<{
  readonly name: string
}> {
  override get message() {
    return `Unknown workflow schedule [${this.name}]`
  }
}

/** A restart found no declaration of what the run is a run of. */
export class UnknownDefinition extends Data.TaggedError('UnknownDefinition')<
  Runnable & { readonly runId: string }
> {
  override get message() {
    const { runId, kind, name, revision } = this
    const route = revision === undefined ? name : `${name}@${revision}`
    return `Cannot restart run [${runId}]: no ${kind} definition [${route}] was given`
  }
}

/**
 * A handler kept running after it was interrupted, for longer than the worker
 * waits. Its attempt is left to its lease, and the worker stops: only a new
 * process is rid of the handler.
 */
export class CleanupTimeout extends Data.TaggedError('CleanupTimeout')<{
  readonly timeoutMs: number
}> {
  override get message() {
    return `Workflow cleanup exceeded ${this.timeoutMs}ms; worker recycling required`
  }
}

/**
 * A retry asked of a durable workflow run whose body already decided from
 * what its operations came to: a failure it saw may have sent it down a
 * branch, which reopening that failure would contradict. Such a run is
 * started again with `restart`.
 */
export class RunNotRetryable extends Data.TaggedError('RunNotRetryable')<{
  readonly runId: string
}> {
  override get message() {
    return `Workflow run [${this.runId}] is durable and cannot be retried in place: restart it`
  }
}

/**
 * A durable workflow's operation ended without its output: the task or child
 * workflow run it started failed, its last attempt included. Its body may
 * catch it and go on; uncaught, it fails the run. The error is as stored,
 * the name and message of what failed, not the value it failed with.
 */
export class OperationFailed extends Data.TaggedError('OperationFailed')<{
  /** The operation's name in the body. */
  readonly operation: string
  readonly error: StoredError
}> {
  override get message() {
    return `Durable operation [${this.operation}] failed: ${this.error.message}`
  }
}

/**
 * Why an input sent to a durable run was not taken:
 *
 * - `missing`: no run has the id, or holds the key;
 * - `other`: the run is of another workflow or revision than the input's;
 * - `ended`: the run has ended or is being cancelled;
 * - `received`: the input already has another value, the first sent;
 * - `closed`: the run stopped waiting for it when its time came;
 * - `taken`: the name is another operation's in the run.
 */
export class InputRefused extends Data.TaggedError('InputRefused')<{
  readonly reason:
    | 'missing'
    | 'other'
    | 'ended'
    | 'received'
    | 'closed'
    | 'taken'
  /** The input's node name in the run: its family and key. */
  readonly input: string
  readonly runId?: string
}> {
  override get message() {
    const run = this.runId === undefined ? '' : ` of run [${this.runId}]`
    return `Input [${this.input}]${run} was refused: ${this.reason}`
  }
}
