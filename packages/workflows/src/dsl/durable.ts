import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'

import type {
  CancellationPolicy,
  DurationString,
  RetryPolicy,
} from '../model.ts'
import type {
  DurableProgram,
  History,
  Operation,
  Program,
  Replay,
  ReplayOutcome,
} from '../program.ts'
import type { Declared, InputOf, Options, OutputOf } from './declaration.ts'
import type { AnyTask } from './task.ts'
import type { ServedWorkflow } from './workflow.ts'
import { OperationFailed } from '../errors.ts'
import { describe } from '../graph/revision.ts'
import { parseDurationMs, storedError } from '../model.ts'
import { boundary } from './codec.ts'
import { assertRevision, route } from './declaration.ts'

/**
 * One replay of a body: the run's history it reads, and what it records of
 * the operations it comes to. Provided by this module for each replay and by
 * nothing else: it is the only requirement a body may have, so a service of
 * a handler's, which exists on workers, is a type error in the coordinator.
 */
export class Durable extends Context.Service<
  Durable,
  {
    readonly history: History
    /** The body came to an operation. */
    readonly reached: (operation: Operation) => void
    /** The body waits on an operation that is not done. */
    readonly waits: () => void
  }
>()('@nmtjs/workflows/dsl/Durable') {}

type Target = AnyTask | ServedWorkflow

/**
 * A workflow a durable one may start: one that lists what it serves, as
 * every declared workflow, static or durable, does.
 */
export type Closed = ServedWorkflow & {
  readonly workflows: readonly ServedWorkflow[]
  readonly tasks: readonly AnyTask[]
}

/**
 * What a body calls to have something done durably. Each call is an
 * operation the run keeps under its name, and a replay that comes to the
 * name again gets what is kept: a name stands for one operation for the
 * whole run, so one in a loop takes the loop's position in it.
 */
export type Operations<T extends AnyTask, W extends Closed> = {
  /** Starts a run of a task the declaration uses, and has its output. */
  readonly task: <D extends T>(
    name: string,
    task: D,
    input: InputOf<D>,
    options?: {
      readonly retry?: RetryPolicy
      readonly timeout?: DurationString
    },
  ) => Effect.Effect<OutputOf<D>, OperationFailed, Durable>
  /** Starts a run of a workflow the declaration uses, and has its output. */
  readonly workflow: <D extends W>(
    name: string,
    workflow: D,
    input: InputOf<D>,
    options?: { readonly cancellation?: CancellationPolicy },
  ) => Effect.Effect<OutputOf<D>, OperationFailed, Durable>
  /**
   * Waits for this long from when the run first comes to it, without a
   * worker held: the run is woken when it is over.
   */
  readonly sleep: (
    name: string,
    duration: DurationString,
  ) => Effect.Effect<void, never, Durable>
  /**
   * The time, in Unix milliseconds, as the run first came to it, and the
   * same in every replay after. The body has no clock of its own.
   */
  readonly now: (name: string) => Effect.Effect<number, never, Durable>
}

/** A durable workflow declared once: its body, and what it may start. */
export type DurableWorkflow<
  Name extends string = string,
  Input = unknown,
  Output = unknown,
  T extends AnyTask = never,
  W extends Closed = never,
  Pool extends string = string,
> = Declared<'workflow', Name, Input, Output, never, DurableProgram, Pool> & {
  readonly revision: string
  readonly mode: 'durable'
  /** A durable workflow has no steps of its own declared. */
  readonly steps: readonly []
  /** What its body may start, as declared. */
  readonly uses: readonly (T | W)[]
  /** This workflow and every child workflow it can start, each once. */
  readonly workflows: readonly (
    | ServedWorkflow<Name, Input, Output, never, Pool>
    | W['workflows'][number]
  )[]
  /** Every task it or its child workflows can start, each once. */
  readonly tasks: readonly (T | W['tasks'][number])[]
  /** The programs of `workflows` and `tasks`: what a registry takes. */
  readonly programs: readonly Program[]
}

export type AnyDurableWorkflow = DurableWorkflow<
  string,
  any,
  any,
  AnyTask,
  Closed,
  string
>

export type DurableOptions<
  Name extends string,
  Input,
  Output,
  T extends AnyTask,
  W extends Closed,
  Pool extends string,
> = Options<Name, Input, Output, Pool> & {
  /**
   * Required: a run replays its body for days, and is pinned to the code it
   * started with. A fix that keeps what runs in flight have stored may ship
   * under the same revision; anything else needs a new one.
   */
  readonly revision: string
  /** The tasks the body may start, each with a revision of its own. */
  readonly tasks?: readonly T[]
  /** The workflows the body may start, each with a revision of its own. */
  readonly workflows?: readonly W[]
}

/**
 * Declares a durable workflow: a body written as ordinary Effect code, with
 * loops and branches on real values, that the coordinator replays from the
 * start against what the run has stored, in every pass. Its operations are
 * what persists: a replay that comes to one done has its output at once, and
 * one that comes to one not done waits there, the run waiting without a
 * worker held.
 *
 * The body must be pure and synchronous: it may require nothing but
 * `Durable`, and must not read the clock, draw random numbers or wait on a
 * promise. Work with effects is a task, started with `d.task`.
 */
export function durable<
  Name extends string,
  Input,
  Output,
  T extends AnyTask = never,
  W extends Closed = never,
  Pool extends string = string,
>(
  options: DurableOptions<Name, Input, Output, T, W, Pool>,
  // The schemas alone decide Input and Output, never the body.
  body: (
    input: NoInfer<Input>,
    d: Operations<T, W>,
  ) => Effect.Effect<NoInfer<Output>, unknown, Durable>,
): DurableWorkflow<Name, Input, Output, T, W, Pool> {
  assertRevision('workflow', options)
  const { name, revision } = options
  if (revision === undefined) {
    throw new Error(`Durable workflow [${name}] needs a revision`)
  }
  const {
    input: from,
    output: to,
    tasks: usedTasks = [],
    workflows: usedWorkflows = [],
    ...declared
  } = options
  const uses: readonly (T | W)[] = [...usedTasks, ...usedWorkflows]
  const named = new Set<string>()
  for (const target of uses) {
    if (target.revision === undefined) {
      throw new Error(
        `Durable workflow [${name}@${revision}] uses unversioned ${target.kind} [${target.name}]: everything a durable workflow starts must declare a revision`,
      )
    }
    // Its graph names what it uses by kind and name, as a step names its
    // target: two revisions of one would be one target there.
    const key = `${target.kind}:${target.name}`
    if (named.has(key)) {
      throw new Error(
        `Durable workflow [${name}@${revision}] uses ${target.kind} [${target.name}] more than once: one revision of each`,
      )
    }
    named.add(key)
  }

  const input = boundary(from, `workflow input [${name}]`)
  const output = boundary(to, `workflow output [${name}]`)
  const operations = operationsOf<T, W>(name, uses)
  const program: DurableProgram = Object.freeze({
    kind: 'workflow',
    mode: 'durable',
    ...route(options),
    replay: replay(name, (stored) =>
      body(input.decode(stored), operations).pipe(
        Effect.map((value) => output.encode(value)),
      ),
    ),
    timeout: options.timeout,
    references: uses.map(reference),
    definition: describe({
      ...options,
      kind: 'workflow',
      steps: [],
      mode: 'durable',
      uses,
    }),
  })

  // The lists hold the declaration itself, so they are filled once it exists.
  const workflows: DurableWorkflow<
    Name,
    Input,
    Output,
    T,
    W,
    Pool
  >['workflows'][number][] = []
  const tasks: (T | W['tasks'][number])[] = []
  const programs: Program[] = []
  const declaration = Object.freeze({
    ...declared,
    revision,
    kind: 'workflow' as const,
    mode: 'durable' as const,
    input,
    output,
    steps: [] as const,
    uses,
    program,
    workflows,
    tasks,
    programs,
  })

  const served = new Set<(typeof workflows)[number]>([declaration])
  const servedTasks = new Set<(typeof tasks)[number]>(usedTasks)
  for (const workflow of usedWorkflows) {
    // A workflow's own list holds it, and every child of it.
    for (const child of workflow.workflows) served.add(child)
    for (const task of workflow.tasks) servedTasks.add(task)
  }
  workflows.push(...served)
  tasks.push(...servedTasks)
  programs.push(...[...workflows, ...tasks].map(({ program }) => program))
  for (const list of [uses, workflows, tasks, programs]) Object.freeze(list)

  return declaration
}

/** A task or child workflow as an operation's program names it. */
const reference = (target: Target) => ({
  ...route(target),
  definition: target.program.definition,
})

const assertName = (workflow: string, name: unknown) => {
  if (typeof name !== 'string' || name === '') {
    throw new Error(
      `Durable workflow [${workflow}] has an operation without a name`,
    )
  }
}

function operationsOf<T extends AnyTask, W extends Closed>(
  workflow: string,
  uses: readonly Target[],
): Operations<T, W> {
  const assertUsed = (target: Target) => {
    if (uses.includes(target)) return
    throw new Error(
      `Durable workflow [${workflow}] starts ${target.kind} [${target.name}], which it does not declare it uses`,
    )
  }

  const run = <D extends Target>(
    name: string,
    target: D,
    value: InputOf<D>,
    fields: (encoded: unknown) => Operation,
  ) =>
    Effect.suspend(() => {
      assertName(workflow, name)
      assertUsed(target)
      return operate(fields(target.input.encode(value)), (output) =>
        Effect.sync(() => target.output.decode(output) as OutputOf<D>),
      )
    })

  return {
    task: (name, task, value, options = {}) =>
      run(name, task, value, (input) => ({
        name,
        kind: 'task',
        task: reference(task),
        input,
        ...(options.retry === undefined ? {} : { retry: options.retry }),
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      })),
    workflow: (name, child, value, options = {}) =>
      run(name, child, value, (input) => ({
        name,
        kind: 'workflow',
        workflow: reference(child),
        input,
        ...(options.cancellation === undefined
          ? {}
          : { cancellation: options.cancellation }),
      })),
    sleep: (name, duration) =>
      Effect.suspend(() => {
        assertName(workflow, name)
        const durationMs = parseDurationMs(duration)
        if (durationMs === undefined) {
          throw new Error(
            `Durable sleep [${workflow}.${name}] has an invalid duration [${duration}]`,
          )
        }
        // Nothing a sleep or a time starts can fail.
        return Effect.orDie(
          operate({ name, kind: 'sleep', durationMs }, () => Effect.void),
        )
      }),
    now: (name) =>
      Effect.suspend(() => {
        assertName(workflow, name)
        return Effect.orDie(
          operate({ name, kind: 'now' }, (output) =>
            Effect.sync(() => {
              if (typeof output !== 'number') {
                throw new TypeError(`Invalid stored time [${workflow}.${name}]`)
              }
              return output
            }),
          ),
        )
      }),
  }
}

/**
 * Reaches an operation in a replay: what its node holds when it is done, a
 * failure when it failed, and otherwise a wait that never ends in this
 * replay, which a pass ends by opening the node or by waiting with it.
 */
function operate<A>(
  operation: Operation,
  read: (output: unknown) => Effect.Effect<A>,
): Effect.Effect<A, OperationFailed, Durable> {
  return Effect.flatMap(Durable, (replaying) => {
    replaying.reached(operation)
    const node = replaying.history.node(operation.name)
    if (node?.status === 'completed') return read(node.output)
    if (node?.status === 'failed') {
      return Effect.fail(
        new OperationFailed({
          operation: operation.name,
          error: node.error ?? { message: 'Operation failed' },
        }),
      )
    }
    // Not opened yet, still under way, or cancelled: a cancelled node never
    // gives a value, and the pass that finds it cancels the run.
    replaying.waits()
    return Effect.never
  })
}

/**
 * A body as the engine runs it: replayed whole and synchronously against a
 * history. Every branch the body has runs until it ends or waits on an
 * operation, so a replay comes to everything a run may open now.
 */
function replay(
  workflow: string,
  body: (input: unknown) => Effect.Effect<unknown, unknown, Durable>,
): Replay {
  return (history) => {
    const operations: Operation[] = []
    let waiting = 0
    // Disposing of a replay that waits interrupts it, which runs what it
    // has to run when interrupted: its finalizers, `Effect.ensuring` and
    // the like. That is no end of the body, which goes on in a later pass,
    // so nothing they come to is an operation of the run.
    let over = false
    const exit = Effect.runSyncExit(
      Effect.provideService(
        Effect.suspend(() => body(history.input)),
        Durable,
        {
          history,
          reached: (operation) => {
            if (!over) operations.push(operation)
          },
          // Nor is a wait a finalizer comes to then one the body is in.
          waits: () => {
            if (!over) waiting += 1
          },
        },
      ),
    )
    over = true
    const outcome = ((): ReplayOutcome => {
      if (Exit.isSuccess(exit)) {
        return { _tag: 'Completed', output: exit.value }
      }
      const failure = Cause.squash(exit.cause)
      if (!Cause.isAsyncFiberError(failure)) {
        return { _tag: 'Failed', error: storedError(failure) }
      }
      // The replay is over, and the fiber left waiting would go on beside it.
      failure.fiber.interruptUnsafe()
      if (waiting > 0) return { _tag: 'Suspended' }
      return {
        _tag: 'Failed',
        error: storedError(
          new Error(
            `Durable workflow [${workflow}] waited on something other than its operations: its body is replayed by the coordinator and cannot wait, asynchronous work belongs in a task`,
            { cause: failure },
          ),
        ),
      }
    })()
    return { outcome, operations }
  }
}
