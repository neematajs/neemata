import type { EffectSchema } from '@nmtjs/common/effect'

import type { TaskOptions } from '../contract/index.ts'
import type { EffectSchemaKind } from '../effect/codec.ts'
import type { HandlerRuntime } from '../effect/handler.ts'
import type { TaskHandler } from '../effect/implement.ts'
import type { TaskImplementation } from '../implement/index.ts'
import type { TaskDefinition, TaskInput, TaskOutput } from '../types/index.ts'
import { defineTask } from '../effect/contract.ts'
import { implementTask } from '../effect/implement.ts'

/** A task declared once: its existing contract and its existing implementation. */
export type Task<
  Name extends string = string,
  Input = unknown,
  Output = unknown,
  R = never,
> = {
  readonly contract: Contract<Name, Input, Output>
  readonly implementation: TaskImplementation<
    Contract<Name, Input, Output>,
    HandlerRuntime<R>
  >
}

type Contract<Name extends string, Input, Output> = TaskDefinition<
  Name,
  Input,
  Output
>

export type AnyTask = Task<string, any, any, any>

export function task<Name extends string, Input, Output, R = never>(
  options: TaskOptions<
    EffectSchemaKind,
    Name,
    EffectSchema<Input>,
    EffectSchema<Output>
  > & {
    /** The execution pool whose workers run this task. */
    readonly pool: string
    // Typed through the contract, as the existing implementer reads it: the
    // schemas alone decide Input and Output, never the handler.
    readonly handler: TaskHandler<
      R,
      TaskInput<Contract<Name, Input, Output>>,
      TaskOutput<Contract<Name, Input, Output>>
    >
  },
): Task<Name, Input, Output, R> {
  const { pool, handler, ...declared } = options
  const contract = defineTask(declared)
  const implementation = implementTask(contract, { pool, handler })

  return Object.freeze({ contract, implementation })
}
