import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { WorkflowEngine } from 'effect/workflow'

/**
 * A step or call name was used twice in one pass over a workflow body. Effect
 * keys a checkpoint by execution and name, so the second use would silently
 * return the first one's stored result.
 */
export class DuplicateName extends Data.TaggedError('DuplicateName')<{
  readonly executionId: string
  readonly name: string
}> {
  override get message() {
    return `Checkpoint name "${this.name}" is used more than once in execution ${this.executionId}; give each loop or map item its own name`
  }
}

/**
 * A step or call was made inside the body of a step. Its checkpoint would
 * share the execution's names without being checked against them; see
 * `claimName`.
 */
export class NestedCheckpoint extends Data.TaggedError('NestedCheckpoint')<{
  readonly executionId: string
  // Not `name`: a stored defect keeps only an error's name and message, and
  // a field called `name` would replace the error's own.
  readonly checkpoint: string
  /** The step whose body asked for the checkpoint. */
  readonly step: string
}> {
  override get message() {
    return `Checkpoint "${this.checkpoint}" is requested inside step "${this.step}" of execution ${this.executionId}; make steps and calls in the workflow body, not inside a step`
  }
}

type Instance = WorkflowEngine.WorkflowInstance['Service']

type Enclosing = { readonly executionId: string; readonly name: string }

// The step whose body is running. A step can start another execution, whose
// handler may inherit this context without being inside the step, so the mark
// names its own execution.
const EnclosingStep = Context.Reference<Option.Option<Enclosing>>(
  '@nmtjs/workflows/native-effect/EnclosingStep',
  { defaultValue: () => Option.none() },
)

/** Runs `body` as the body of step `name`, where no name can be claimed. */
export function withinStep<A, E, R>(
  name: string,
  body: Effect.Effect<A, E, R>,
) {
  return Effect.flatMap(WorkflowEngine.WorkflowInstance, ({ executionId }) =>
    Effect.provideService(
      body,
      EnclosingStep,
      Option.some({ executionId, name }),
    ),
  )
}

// Claims are kept per pass over the body. The engine builds a fresh instance
// for every replay, but hands the arms of a durable race a copy of it, and the
// memory engine reuses the instance's scope across replays. The map of awaited
// deferreds is the one object that is new for each pass and shared by copies.
const claimed = new WeakMap<Instance['awaitedDeferreds'], Set<string>>()

/**
 * Reserves a checkpoint name for this pass over the workflow body.
 *
 * A step's body is outside what a pass can see: the engine runs it under an
 * instance of its own and skips it once the step has a result, so a name
 * claimed there would be known in one pass and missing from the next. Claims
 * made inside a step are therefore refused instead of tracked.
 */
export function claimName(instance: Instance, name: string) {
  return Effect.gen(function* () {
    const { executionId } = instance
    const enclosing = yield* EnclosingStep
    if (
      Option.isSome(enclosing) &&
      enclosing.value.executionId === executionId
    ) {
      const nested = new NestedCheckpoint({
        executionId,
        checkpoint: name,
        step: enclosing.value.name,
      })
      return yield* Effect.die(nested)
    }

    const pass = instance.awaitedDeferreds
    let names = claimed.get(pass)
    if (!names) {
      names = new Set()
      claimed.set(pass, names)
    }

    if (names.has(name)) {
      return yield* Effect.die(new DuplicateName({ executionId, name }))
    }
    names.add(name)
  })
}
