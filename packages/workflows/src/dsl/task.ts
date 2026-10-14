import * as Effect from 'effect/Effect'

import type { RetryPolicy } from '../model.ts'
import type { Execute, TaskProgram } from '../program.ts'
import type { Boundary } from './codec.ts'
import type { Declared, Handler, Options } from './declaration.ts'
import { describe } from '../graph/revision.ts'
import { boundary } from './codec.ts'
import { assertRevision, route } from './declaration.ts'

/** A task declared once: schemas, policies and handler, and its program. */
export type Task<
  Name extends string = string,
  Input = unknown,
  Output = unknown,
  R = never,
  Pool extends string = string,
> = Declared<'task', Name, Input, Output, R, TaskProgram, Pool> & {
  readonly retry?: RetryPolicy
}

export type AnyTask = Task<string, any, any, any>

/**
 * A handler between its two boundaries. A stored input that does not decode
 * and an output that does not encode fail the attempt, as the handler would.
 */
export function execution<Input, Output>(
  input: Boundary<Input>,
  output: Boundary<Output>,
  handler: Handler<any, Input, Output>,
): Execute {
  return (stored, attempt) =>
    Effect.suspend(() =>
      Effect.map(handler(input.decode(stored), attempt), (value) =>
        output.encode(value),
      ),
    )
}

export function task<
  Name extends string,
  Input,
  Output,
  R = never,
  Pool extends string = string,
>(
  options: Options<Name, Input, Output, Pool> & {
    readonly retry?: RetryPolicy
    // The schemas alone decide Input and Output, never the handler.
    readonly handler: Handler<R, NoInfer<Input>, NoInfer<Output>>
  },
): Task<Name, Input, Output, R, Pool> {
  assertRevision('task', options)
  const { input: from, output: to, handler, ...declared } = options
  const { name, retry, timeout } = options
  const input = boundary(from, `task input [${name}]`)
  const output = boundary(to, `task output [${name}]`)
  const program: TaskProgram = Object.freeze({
    kind: 'task',
    ...route(options),
    execute: execution(input, output, handler),
    retry,
    timeout,
    definition: describe({ ...options, kind: 'task' }),
  })

  return Object.freeze({ ...declared, kind: 'task', input, output, program })
}
