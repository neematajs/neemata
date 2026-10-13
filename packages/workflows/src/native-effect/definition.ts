import { ClusterSchema } from 'effect/cluster'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { Workflow, WorkflowEngine } from 'effect/workflow'

import { claimName } from './names.ts'

/**
 * Reserved payload field carrying the caller's identity for a child execution.
 * Effect derives an execution id from the workflow name and `idempotencyKey`
 * only, so a child started through `call` needs its parent and step encoded in
 * the payload to stay distinct from another parent's child.
 */
export const callField = '~nmtjs/call'

type CallFields = {
  readonly [callField]: Schema.optional<typeof Schema.String>
}

export type Kind = 'workflow' | 'task'

/** What a definition is to Neemata; the engine treats both kinds identically. */
export const DefinitionKind = Context.Reference<Kind>(
  '@nmtjs/workflows/native-effect/DefinitionKind',
  { defaultValue: () => 'workflow' },
)

/** The pool a definition is placed in, mirrored into `ClusterSchema.ShardGroup`. */
export const Pool = Context.Reference<string>(
  '@nmtjs/workflows/native-effect/Pool',
  { defaultValue: () => 'default' },
)

export type Definition<
  Name extends string = string,
  Fields extends Schema.Struct.Fields = Schema.Struct.Fields,
  Success extends Schema.Top = Schema.Top,
  Error extends Schema.Top = Schema.Top,
> = Workflow.Workflow<Name, Schema.Struct<Fields & CallFields>, Success, Error>

export type Options<
  Fields extends Schema.Struct.Fields,
  Success extends Schema.Top,
  Error extends Schema.Top,
> = {
  readonly payload: Fields
  readonly success?: Success
  readonly error?: Error
  /**
   * Business identity of a root execution. Starting again with the same key
   * joins the existing execution in any state.
   */
  readonly idempotencyKey: (payload: Schema.Struct.Type<Fields>) => string
  /** Shard group whose runners execute this definition. */
  readonly pool?: string
}

function define<
  const Name extends string,
  Fields extends Schema.Struct.Fields,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(kind: Kind, name: Name, options: Options<Fields, Success, Error>) {
  const pool = options.pool ?? 'default'
  const annotations = Context.empty().pipe(
    Context.add(DefinitionKind, kind),
    Context.add(Pool, pool),
    Context.add(ClusterSchema.ShardGroup, () => pool),
  )
  const payload = {
    ...options.payload,
    [callField]: Schema.optional(Schema.String),
  } as Fields & CallFields

  const workflow = Workflow.make(name, {
    payload,
    success: options.success,
    error: options.error,
    annotations,
    idempotencyKey: (input) => {
      const fields = input as Schema.Struct.Type<Fields> & {
        readonly [callField]?: string
      }
      return fields[callField] ?? options.idempotencyKey(fields)
    },
  })
  // `Workflow.make` types its payload through a conditional on the field map,
  // which TypeScript cannot resolve while `Fields` is still generic.
  return workflow as unknown as Definition<Name, Fields, Success, Error>
}

/** A durable program: its handler replays, its steps and calls checkpoint. */
export function defineWorkflow<
  const Name extends string,
  Fields extends Schema.Struct.Fields,
  Success extends Schema.Top = Schema.Void,
  Error extends Schema.Top = Schema.Never,
>(name: Name, options: Options<Fields, Success, Error>) {
  return define('workflow', name, options)
}

/**
 * A unit of work with its own execution, usually placed in another pool. It is
 * a native child workflow, so it has its own persisted result and can be
 * started, polled and interrupted on its own.
 */
export function defineTask<
  const Name extends string,
  Fields extends Schema.Struct.Fields,
  Success extends Schema.Top = Schema.Void,
  Error extends Schema.Top = Schema.Never,
>(name: Name, options: Options<Fields, Success, Error>) {
  return define('task', name, options)
}

/**
 * Runs a task or child workflow from inside a workflow and waits for it. The
 * child's identity is the parent execution plus `name`, so the same payload
 * called from two steps or two parents runs twice, while a replay of this
 * parent joins the execution it already started.
 */
export function call<
  Name extends string,
  Fields extends Schema.Struct.Fields,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(
  name: string,
  definition: Definition<Name, Fields, Success, Error>,
  payload: Schema.Struct<Fields>['~type.make.in'],
) {
  return Effect.gen(function* () {
    const instance = yield* WorkflowEngine.WorkflowInstance
    yield* claimName(instance, name)

    const input = {
      ...payload,
      [callField]: `${instance.executionId}/${name}`,
    } as Schema.Struct<Fields & CallFields>['~type.make.in']
    return yield* definition.execute(input)
  })
}
