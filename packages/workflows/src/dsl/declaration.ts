import type * as Effect from 'effect/Effect'

import type {
  DurationString,
  Route,
  RunUniqueBehavior,
  RunUniqueScope,
  StoredRun,
} from '../model.ts'
import type { AttemptInfo } from '../program.ts'
import type { Boundary, EffectSchema } from './codec.ts'

declare const services: unique symbol

export type Labels = {
  readonly title?: string
  readonly description?: string
}

export type UniqueBuilder<Input> =
  | ((input: Input) => readonly unknown[])
  | {
      readonly key: (input: Input) => readonly unknown[]
      readonly scope?: RunUniqueScope
      readonly behavior?: RunUniqueBehavior
    }

/** What a declaration says about every run started from it, from its input. */
type StartOptions<Input> = {
  readonly tags?: (input: Input) => Readonly<Record<string, string>>
  readonly idempotency?: (input: Input) => readonly unknown[]
  readonly unique?: UniqueBuilder<Input>
}

type Identity<Name extends string, Pool extends string> = Labels & {
  readonly name: Name
  /**
   * Pins runs to this exact code. Opaque and compared for equality only;
   * absent is the unversioned lane.
   */
  readonly revision?: string
  /** The pool whose workers run the handlers declared here. */
  readonly pool: Pool
  /** Limits one attempt of a task, and the whole run of a workflow. */
  readonly timeout?: DurationString
}

export type Options<
  Name extends string,
  Input,
  Output,
  Pool extends string = string,
> = Identity<Name, Pool> &
  StartOptions<Input> & {
    readonly input: EffectSchema<Input>
    readonly output: EffectSchema<Output>
  }

/**
 * What a task and a workflow declaration share. `program` is what the engine
 * runs; `input` and `output` are how a caller crosses to stored values; the
 * rest is carried as declared, for whoever starts and serves runs.
 */
export type Declared<
  Kind extends 'task' | 'workflow',
  Name extends string,
  Input,
  Output,
  R,
  Program,
  Pool extends string = string,
> = Identity<Name, Pool> &
  StartOptions<Input> & {
    readonly kind: Kind
    readonly input: Boundary<Input>
    readonly output: Boundary<Output>
    readonly program: Program
    /** Type-only: the services the handlers declared here require. */
    readonly [services]?: R
  }

type AnyDeclared = Declared<'task' | 'workflow', string, any, any, any, unknown>

export type InputOf<D> = D extends { readonly input: Boundary<infer Input> }
  ? Input
  : never

export type OutputOf<D> = D extends { readonly output: Boundary<infer Output> }
  ? Output
  : never

/**
 * The services a worker must provide to run the handlers a declaration holds:
 * a task's handler, or a workflow's own activities. What a workflow can start
 * is in its `workflows` and `tasks`, each with its own.
 */
export type Services<D> = D extends { readonly [services]?: infer R }
  ? // The property is optional, so what is inferred includes its absence.
    Exclude<R, undefined>
  : never

/**
 * A task or activity handler: it receives the decoded input and produces the
 * decoded output. Interruption is how it is told to stop.
 */
export type Handler<R, Input, Output> = (
  input: Input,
  attempt: AttemptInfo,
) => Effect.Effect<Output, unknown, R>

export function assertRevision(
  kind: 'task' | 'workflow',
  { name, revision }: { readonly name: string; readonly revision?: unknown },
) {
  if (revision === undefined) return
  if (typeof revision !== 'string' || revision === '') {
    throw new Error(
      `Invalid ${kind} revision [${name}]: expected a non-empty string`,
    )
  }
}

export const route = ({ name, revision }: Route): Route =>
  revision === undefined ? { name } : { name, revision }

/** A stored run as its declaration types it. */
export type DecodedRun<Input, Output> = Omit<StoredRun, 'input' | 'output'> & {
  readonly input: Input
  /** Present once the run has completed. */
  readonly output?: Output
}

/**
 * Decodes a run for a caller. Only the declaration a run was started from is
 * known to read its values back right, so any other run is refused.
 */
export function decodeRun<D extends AnyDeclared>(
  declaration: D,
  run: StoredRun,
): DecodedRun<InputOf<D>, OutputOf<D>> {
  const { kind, name, revision } = declaration
  if (run.kind !== kind || run.name !== name || run.revision !== revision) {
    throw new Error(
      `Run [${run.id}] is not a run of ${kind} [${name}${revision === undefined ? '' : `@${revision}`}]`,
    )
  }

  const { input, output, ...rest } = run
  return {
    ...rest,
    input: declaration.input.decode(input),
    ...(run.status === 'completed'
      ? { output: declaration.output.decode(output) }
      : {}),
  }
}
