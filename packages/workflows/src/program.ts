import type * as Effect from 'effect/Effect'

import type {
  AttemptCommand,
  CancellationPolicy,
  DefinitionRecord,
  DurationString,
  RetryPolicy,
  Route,
} from './model.ts'
import { caseKey, memberKey, SELF } from './model.ts'

/**
 * Programs are what the engine runs. They hold stored values only: whatever
 * builds a program (the authoring layer) decodes what its functions read and
 * encodes what they return, so the engine never sees a schema.
 */

/**
 * What the authoring layer says a program is. The engine records it on runs,
 * saves it and compares it as text, and never reads into it: a graph and a
 * manifest mean something only to whoever wrote them.
 */
export type Described = {
  /** Names the program's graph; recorded on every run of the program. */
  readonly graphHash: string
  /** The labels a run of the program is created with. */
  readonly presentation?: unknown
  /**
   * What a run of the program needs saved: its graph, and for a revision its
   * manifest and the records of everything the manifest binds. An unversioned
   * program brings its own graph only: nothing pins what it references, so
   * each of its children brings its own when it is created.
   */
  readonly records: readonly DefinitionRecord[]
}

/** Stored outputs of a run's completed steps, by step name. */
export type Outputs = Readonly<Record<string, unknown>>

/**
 * The case each completed branch of a run took, by step name. A branch's
 * output is its case's, so only the case says what produced it.
 */
export type Selected = Readonly<Record<string, string>>

/**
 * A value the coordinator computes for a run: pure and synchronous. Throwing
 * fails the step it was computed for, or the run when it is the result.
 */
export type Compute<A = unknown> = (
  outputs: Outputs,
  input: unknown,
  selected: Selected,
) => A

/** What a handler is told about the attempt it runs. */
export type AttemptInfo = {
  readonly runId: string
  readonly nodeName: string
  /**
   * Which child of the node the work is: its only one, a branch's case, a
   * parallel's member. A task run has one node with one child.
   */
  readonly childKey: string
  /** Counts every attempt of the work, from 1. */
  readonly attemptNumber: number
  /**
   * Names the work and not the attempt: every attempt of one child of one
   * node of one run gets the same key, a manual retry's included, and no
   * other work gets it. A handler passes it to whatever it calls that must
   * not happen twice, so an attempt that is run again, after a failure or
   * because its outcome was never recorded, repeats no side effect. Opaque:
   * it is to be compared, never read.
   */
  readonly idempotencyKey: string
}

/**
 * A task or activity handler, from stored input to stored output. A failure
 * or a defect fails the attempt; interruption is how it is told to stop. Its
 * requirements are the worker's to provide.
 */
export type Execute = (
  input: unknown,
  attempt: AttemptInfo,
) => Effect.Effect<unknown, unknown, any>

type AttemptPolicy = {
  readonly retry?: RetryPolicy
  /** Limits one attempt. */
  readonly timeout?: DurationString
}

/**
 * A task or workflow a step starts a run of. `definition` is the description
 * of that program: the coordinator of the parent creates the run, and may
 * hold nothing else of the child's.
 */
type Reference = Route & { readonly definition?: Described }

/** Work a step, a branch case, a parallel member or a map item stands for. */
export type Target =
  | (AttemptPolicy & { readonly kind: 'activity'; readonly execute: Execute })
  /** A task run; `retry` and `timeout` override the task's own. */
  | (AttemptPolicy & { readonly kind: 'task'; readonly task: Reference })
  | {
      readonly kind: 'workflow'
      readonly workflow: Reference
      readonly cancellation?: CancellationPolicy
    }

/** A target with the input it receives. */
export type Leaf = Target & { readonly input: Compute }

export type Step = { readonly name: string } & (
  | Leaf
  | {
      readonly kind: 'branch'
      /** Picks the one case that runs. */
      readonly select: Compute<string>
      readonly cases: Readonly<Record<string, Leaf>>
    }
  | {
      readonly kind: 'parallel'
      readonly members: Readonly<Record<string, Leaf>>
    }
  | {
      readonly kind: 'map'
      /** Computed once, when the run reaches the step. */
      readonly items: Compute<readonly unknown[]>
      /** Computed per item, when the engine starts it. */
      readonly input: (
        outputs: Outputs,
        input: unknown,
        item: unknown,
        index: number,
        selected: Selected,
      ) => unknown
      readonly target: Exclude<Target, { kind: 'activity' }>
      /** At most this many items run at once; all of them when omitted. */
      readonly concurrency?: number
    }
)

/** What the coordinator needs to advance runs of one workflow revision. */
export type WorkflowProgram = Route & {
  readonly kind: 'workflow'
  readonly steps: readonly Step[]
  readonly result: Compute
  /** Limits the whole run. */
  readonly timeout?: DurationString
  /** Absent for a program written by hand: its runs are then never checked. */
  readonly definition?: Described
}

/** One task revision: a handler that runs as a run of its own. */
export type TaskProgram = Route &
  AttemptPolicy & {
    readonly kind: 'task'
    readonly execute: Execute
    readonly definition?: Described
  }

export type Program = WorkflowProgram | TaskProgram

/**
 * The handler an attempt command names, with the limits it runs under: an
 * activity's are its step's, a task's are its own unless the command
 * overrides them.
 */
export type Executable = AttemptPolicy & { readonly execute: Execute }

export type Registry = {
  readonly workflow: (route: Route) => WorkflowProgram | undefined
  readonly task: (route: Route) => TaskProgram | undefined
  /** `undefined` when no registered code can run the attempt. */
  readonly executable: (command: AttemptCommand) => Executable | undefined
  readonly workflows: readonly Route[]
  readonly tasks: readonly Route[]
}

function routeKey({ name, revision }: Route) {
  return JSON.stringify([name, revision ?? null])
}

const routeOf = ({ name, revision }: Route): Route =>
  revision === undefined ? { name } : { name, revision }

/** What the child of a step at `childKey` runs. A map's children are runs. */
function leaf(step: Step, childKey: string): Leaf | undefined {
  switch (step.kind) {
    case 'branch':
      return Object.entries(step.cases).find(
        ([key]) => caseKey(key) === childKey,
      )?.[1]
    case 'parallel':
      return Object.entries(step.members).find(
        ([key]) => memberKey(key) === childKey,
      )?.[1]
    case 'map':
      return undefined
    default:
      return childKey === SELF ? step : undefined
  }
}

export function registry(programs: readonly Program[]): Registry {
  const workflows = new Map<string, WorkflowProgram>()
  const tasks = new Map<string, TaskProgram>()

  for (const program of programs) {
    const known: Map<string, Program> =
      program.kind === 'workflow' ? workflows : tasks
    const key = routeKey(program)
    if (known.has(key)) {
      throw new Error(
        `${program.kind === 'workflow' ? 'Workflow' : 'Task'} [${program.name}] is registered twice for one revision`,
      )
    }
    known.set(key, program)
  }

  return {
    workflow: (route) => workflows.get(routeKey(route)),
    task: (route) => tasks.get(routeKey(route)),
    executable(command) {
      if (command.kind === 'runTask') {
        const task = tasks.get(routeKey(command))
        const { retry, timeout } = command
        return (
          task && {
            ...task,
            ...(retry === undefined ? {} : { retry }),
            ...(timeout === undefined ? {} : { timeout }),
          }
        )
      }

      const step = workflows
        .get(routeKey(command))
        ?.steps.find((step) => step.name === command.nodeName)
      const target = step && leaf(step, command.childKey)
      return target?.kind === 'activity' ? target : undefined
    },
    workflows: Array.from(workflows.values(), routeOf),
    tasks: Array.from(tasks.values(), routeOf),
  }
}
