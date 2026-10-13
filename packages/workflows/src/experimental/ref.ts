declare const output: unique symbol

/** One workflow's authoring scope. References and plans never cross it. */
export type Scope = { readonly workflow: string }

/** Where a value is read: only the input and earlier steps exist there. */
export type Position = {
  readonly scope: Scope
  /** Steps placed before this index have produced their output. */
  readonly limit: number
  readonly label: string
}

/** Decoded outputs of completed steps, as the engine passes them to callbacks. */
export type Outputs = Readonly<Record<string, unknown>>

const INPUT = -1

/**
 * The future output of a step, or the workflow input. It holds no value: only
 * `read` inside a deferred callback resolves it, once the run has produced it.
 */
export class Ref<out A> {
  /** Type-only: what `read` returns for this reference. */
  declare readonly [output]?: A
  readonly #scope: Scope
  readonly #name: string
  readonly #index: number

  constructor(scope: Scope, name: string, index: number) {
    this.#scope = scope
    this.#name = name
    this.#index = index
    Object.freeze(this)
  }

  static input<A>(scope: Scope): Ref<A> {
    return new Ref(scope, 'input', INPUT)
  }

  /** Rejects a reference that has no value at the position reading it. */
  static assertReadable(ref: Ref<unknown>, at: Position) {
    const name = `${ref.#scope.workflow}.${ref.#name}`

    if (ref.#scope !== at.scope) {
      throw new Error(
        `Reference [${name}] belongs to another workflow and cannot be read in [${at.label}]`,
      )
    }
    if (ref.#index >= at.limit) {
      throw new Error(
        `Reference [${name}] is produced after [${at.label}] and cannot be read there`,
      )
    }
  }

  static read<A>(ref: Ref<A>, at: Position, outputs: Outputs, input: unknown) {
    Ref.assertReadable(ref, at)
    const value = ref.#index === INPUT ? input : outputs[ref.#name]
    // The engine decoded this value with the schema the reference is typed
    // from, and hands it to callbacks untyped.
    return value as A
  }
}

export type Read = <A>(ref: Ref<A>) => A

/** Runs when the engine reaches its step, never while the workflow is built. */
export type Deferred<A> = (read: Read) => A

/** A value a step receives: another step's output as is, or one derived. */
export type Value<A> = Ref<A> | Deferred<A>

/** `read` for one position of one run: its outputs so far and its input. */
export function reader(at: Position, outputs: Outputs, input: unknown): Read {
  return (ref) => Ref.read(ref, at, outputs, input)
}

export function resolve<A>(
  value: Value<A>,
  at: Position,
  outputs: Outputs,
  input: unknown,
): A {
  const read = reader(at, outputs, input)
  return typeof value === 'function' ? value(read) : read(value)
}

/** Checks at build time what can be checked without running a callback. */
export function assertValue(value: Value<unknown>, at: Position) {
  if (typeof value === 'function') return
  // Types rule this out; untyped callers get a build error, not a run failure.
  if (!(value instanceof Ref)) {
    throw new Error(
      `[${at.label}] needs a reference or a deferred callback, received ${typeof value}`,
    )
  }
  Ref.assertReadable(value, at)
}
