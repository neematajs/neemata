import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'

import type { InputOf } from '../src/dsl/index.ts'
import type { AnyTask } from '../src/dsl/task.ts'
import type { ServedWorkflow } from '../src/dsl/workflow.ts'
import type { RunRecords } from '../src/model.ts'
import type { StartInput } from '../src/plan/start.ts'
import type { Program } from '../src/program.ts'
import { begin, coordinate, settle, start } from '../src/engine.ts'
import { makeInMemoryStore } from '../src/memory.ts'
import { isTerminal, storedError } from '../src/model.ts'
import { registry } from '../src/program.ts'
import { Store } from '../src/store.ts'

const LEASE = 30_000
const LIMIT = 100

/**
 * Serves programs on an in-memory store of their own: coordination passes by
 * the engine, handlers run here with `context`, as a worker would.
 */
export function serve<R = never>(
  programs: readonly Program[],
  context: Context.Context<R> = Context.empty() as Context.Context<R>,
) {
  const { store, inspect } = makeInMemoryStore()
  const served = registry(programs)
  const provide = <A, E>(effect: Effect.Effect<A, E, Store>) =>
    Effect.provideService(effect, Store, store)

  /** One pass of every run that is due one; answers how many. */
  const pass = provide(
    Effect.gen(function* () {
      const claims = yield* store.claim({
        lanes: [{ kind: 'continueRun', routes: served.workflows }],
        limit: LIMIT,
        leaseMs: LEASE,
      })
      for (const claim of claims) yield* coordinate(served, claim)
      return claims.length
    }),
  )

  /** Runs the handler of every due attempt and settles what it came to. */
  const execute = provide(
    Effect.gen(function* () {
      const claims = yield* store.claim({
        lanes: [
          { kind: 'runAttempt', routes: served.workflows },
          { kind: 'runTask', routes: served.tasks },
        ],
        limit: LIMIT,
        leaseMs: LEASE,
      })

      for (const claim of claims) {
        const begun = yield* begin(served, claim)
        if (begun._tag !== 'Begun') {
          return yield* Effect.die(`Attempt was not begun: ${begun._tag}`)
        }
        const exit = yield* Effect.exit(
          Effect.provideContext(
            begun.executable.execute(claim.command.input, begun.attempt),
            context,
          ),
        )
        yield* settle(
          served,
          claim,
          Exit.isSuccess(exit)
            ? { _tag: 'Completed', output: exit.value }
            : { _tag: 'Failed', error: storedError(Cause.squash(exit.cause)) },
        )
      }
      return claims.length
    }),
  )

  const load = (runId: string) =>
    Effect.map(store.load(runId), (records) => records!)

  /** Passes and executes until the run has ended. */
  const drain = (runId: string) =>
    Effect.gen(function* () {
      for (let round = 0; round < 20; round++) {
        yield* pass
        yield* execute
        const records = yield* load(runId)
        if (isTerminal(records.run.status)) return records
      }
      return yield* Effect.die(`Run [${runId}] did not settle`)
    })

  /** Starts a run from what is stored for it, as the engine takes it. */
  const startStored = (input: StartInput) =>
    Effect.map(provide(start(input)), ({ run }) => run)

  /** Starts a run as a typed caller would: with the encoded input. */
  const startTyped = <D extends AnyTask | ServedWorkflow>(
    declaration: D,
    input: InputOf<D>,
  ) => {
    const { kind, name, revision } = declaration
    return startStored({
      kind,
      name,
      ...(revision === undefined ? {} : { revision }),
      input: declaration.input.encode(input),
    })
  }

  return {
    inspect,
    pass,
    execute,
    load,
    drain,
    start: startTyped,
    startStored,
    /** Starts a run and works it to its end. */
    run: <D extends AnyTask | ServedWorkflow>(
      declaration: D,
      input: InputOf<D>,
    ) => Effect.flatMap(startTyped(declaration, input), ({ id }) => drain(id)),
  }
}

/** The stored node of a run, by name. */
export const node = (records: RunRecords, name: string) =>
  records.nodes.find((candidate) => candidate.name === name)

const erased = (value: unknown): unknown =>
  typeof value === 'function'
    ? 'function'
    : value !== null && typeof value === 'object'
      ? Array.isArray(value)
        ? value.map(erased)
        : Object.fromEntries(
            Object.entries(value).flatMap(([key, member]) =>
              key === 'definition' ? [] : [[key, erased(member)]],
            ),
          )
      : value

/**
 * A program without its functions, which no two declarations share, and
 * without the descriptions it carries, which `revisions.spec.ts` asserts.
 */
export const shape = (program: Program) => erased(program)
