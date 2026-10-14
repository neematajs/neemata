import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'

/** One workflow's authoring scope. References and plans never cross it. */
export type Scope = { readonly workflow: string }

/** Where a value is computed: only the input and earlier steps exist there. */
export type Position = {
  readonly scope: Scope
  /** Steps placed before this index have produced their output. */
  readonly limit: number
  readonly label: string
}

/** A step output or the workflow input: the only things a run produces. */
export type Source = {
  readonly scope: Scope
  readonly name: string
  /** The step's place in the workflow; `INPUT` for the workflow input. */
  readonly index: number
}

export const INPUT = -1

/** The decoded value a run holds for a source its position may read. */
export type Read = (source: Source) => unknown

/**
 * What one run has produced when the engine computes a value for it. Provided
 * by this module for each computation and by nothing else: it is the only
 * requirement such an Effect may have, so a handler's services, which exist on
 * workers, are a type error in the coordinator.
 */
export class Run extends Context.Service<Run, { readonly read: Read }>()(
  '@nmtjs/workflows/dsl/Run',
) {}

/**
 * The future output of a step, the workflow input, or anything computed from
 * them: an Effect that needs a run to have a value. Building one runs nothing;
 * the engine runs it when the run reaches the step that uses it.
 */
export type Ref<A> = Effect.Effect<A, never, Run>

// A reference handed to a step as it is can be checked while the workflow is
// built. An Effect computed from references is opaque until it runs.
const sources = new WeakMap<object, Source>()

function reference<A>(source: Source): Ref<A> {
  const ref = Effect.map(Run, (run) => run.read(source) as A)
  sources.set(ref, source)
  return ref
}

export function stepRef<A>(scope: Scope, name: string, index: number): Ref<A> {
  return reference({ scope, name, index })
}

export function inputRef<A>(scope: Scope): Ref<A> {
  return reference({ scope, name: 'input', index: INPUT })
}

/** Rejects a source that has no value at the position reading it. */
function assertReadable({ scope, name, index }: Source, at: Position) {
  const label = `${scope.workflow}.${name}`

  if (scope !== at.scope) {
    throw new Error(
      `Reference [${label}] belongs to another workflow and cannot be read in [${at.label}]`,
    )
  }
  if (index >= at.limit) {
    throw new Error(
      `Reference [${label}] is produced after [${at.label}] and cannot be read there`,
    )
  }
}

/**
 * Computes a value for one position of one run. The engine calls a program's
 * functions synchronously, so the Effect must finish without waiting.
 */
export function resolve<A>(value: Ref<A>, at: Position, read: Read): A {
  const exit = Effect.runSyncExit(
    Effect.provideService(value, Run, {
      read(source) {
        assertReadable(source, at)
        return read(source)
      },
    }),
  )
  if (Exit.isSuccess(exit)) return exit.value

  // The failure channel is `never`, so this is a defect: rethrown as it was
  // thrown, for the engine to fail the step or the run with.
  const defect = Cause.squash(exit.cause)
  if (Cause.isAsyncFiberError(defect)) {
    // The computation is refused, and is still running in the fiber the
    // error holds: left alone, it would go on beside the run it failed.
    defect.fiber.interruptUnsafe()
    throw new Error(
      `[${at.label}] is computed in the coordinator and cannot wait: asynchronous work belongs in a task or an activity`,
      { cause: defect },
    )
  }
  throw defect
}

/** Checks at build time what can be checked without a run. */
export function assertValue(value: Ref<unknown>, at: Position) {
  // Types rule this out; untyped callers get a build error, not a run failure.
  if (!Effect.isEffect(value)) {
    throw new Error(
      `[${at.label}] needs a reference or an Effect computed from references, received ${typeof value}`,
    )
  }
  const source = sources.get(value)
  if (source) assertReadable(source, at)
}
