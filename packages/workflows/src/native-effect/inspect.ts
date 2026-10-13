import type { Workflow } from 'effect/workflow'
import { Snowflake } from 'effect/cluster'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { SqlClient } from 'effect/sql'

import { defaultPrefix } from './sql.ts'

export type EntryKind = 'run' | 'activity' | 'signal' | 'timer' | 'child'

export type EntryState = 'pending' | 'suspended' | 'succeeded' | 'failed'

/** One message the engine stored for an execution, with its outcome so far. */
export type Entry = {
  /** The engine's request id; ids sort in the order requests were made. */
  readonly id: string
  readonly kind: EntryKind
  readonly name: string
  /** Set for activities: each retry is a separate entry. */
  readonly attempt?: number
  readonly state: EntryState
  readonly at: DateTime.Utc
  /** The stored Exit as the engine encoded it, when there is one. */
  readonly exit?: unknown
}

const ExitShape = Schema.Struct({
  _tag: Schema.Literals(['Success', 'Failure']),
  value: Schema.optional(Schema.Unknown),
})

// A workflow or activity reply wraps the real outcome in a Result, whereas a
// completed deferred carries its Exit directly in the request payload.
const ResultShape = Schema.Struct({
  _tag: Schema.Literals(['Complete', 'Suspended']),
  exit: Schema.optional(ExitShape),
})

const Row = Schema.Struct({
  id: Schema.String,
  entity_type: Schema.String,
  tag: Schema.String,
  // Decoded per kind below: a run's payload is the workflow's own input and
  // may hold anything, including fields named like the engine's.
  payload: Schema.String,
  reply: Schema.NullOr(Schema.fromJsonString(ExitShape)),
})

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row))
const decodeResult = Schema.decodeUnknownOption(ResultShape)
const decodeActivity = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ name: Schema.String, attempt: Schema.Number }),
  ),
)
const decodeSignal = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ name: Schema.String, exit: ExitShape }),
  ),
)
const decodeTimer = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String })),
)
const decodeChild = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ childExecutionId: Schema.optional(Schema.String) }),
  ),
)

const clockEntity = 'Workflow/-/DurableClock'
// The engine's numeric encodings for a request message and a terminal reply.
const requestKind = 0
const exitReplyKind = 0

function settled(exit: typeof ExitShape.Type): EntryState {
  return exit._tag === 'Success' ? 'succeeded' : 'failed'
}

/** The state of a run or activity, whose reply wraps a Result. */
function resultState(reply: typeof ExitShape.Type | null): EntryState {
  if (!reply) return 'pending'
  if (reply._tag === 'Failure') return 'failed'

  const result = decodeResult(reply.value)
  if (result._tag === 'Some' && result.value.exit) {
    return settled(result.value.exit)
  }
  return 'suspended'
}

type Described = Pick<Entry, 'kind' | 'name' | 'state' | 'attempt'>

function classify(row: typeof Row.Type, workflow: string) {
  const { tag, payload, reply } = row

  return Effect.gen(function* (): Effect.fn.Return<
    Described,
    Schema.SchemaError
  > {
    if (row.entity_type === clockEntity) {
      const { name } = yield* decodeTimer(payload)
      return { kind: 'timer', name, state: reply ? 'succeeded' : 'pending' }
    }
    if (tag === 'deferred') {
      const { name, exit } = yield* decodeSignal(payload)
      return { kind: 'signal', name, state: settled(exit) }
    }
    if (tag === 'resume') {
      const { childExecutionId: name = '' } = yield* decodeChild(payload)
      return { kind: 'child', name, state: reply ? 'succeeded' : 'pending' }
    }
    if (tag === 'activity') {
      const { name, attempt } = yield* decodeActivity(payload)
      return { kind: 'activity', name, attempt, state: resultState(reply) }
    }
    return { kind: 'run', name: workflow, state: resultState(reply) }
  })
}

/**
 * Lists what the engine has stored for one execution: its run, every activity
 * attempt, completed signals, timers and child wake-ups.
 *
 * This reads the engine's own tables and decides nothing. Their layout is an
 * Effect implementation detail, so treat the result as diagnostic: a signal
 * that is awaited but not yet sent has no row, and a child's own steps are
 * listed under the child's execution id.
 */
export function inspect(
  workflow: Workflow.Any,
  executionId: string,
  options?: { readonly prefix?: string },
) {
  const prefix = options?.prefix ?? defaultPrefix

  return Effect.gen(function* () {
    // The engine reads and writes these tables with transforms off; a client
    // that renames columns would otherwise hand back keys this cannot decode.
    const sql = (yield* SqlClient.SqlClient).withoutTransforms()
    const messages = sql(`${prefix}_messages`)
    const replies = sql(`${prefix}_replies`)
    const types = [`Workflow/${workflow._tag}`, clockEntity]

    const rows = yield* sql`
      SELECT m.id::text AS id, m.entity_type, m.tag, m.payload, r.payload AS reply
      FROM ${messages} m
      LEFT JOIN ${replies} r
        ON r.request_id = m.id AND r.kind = ${exitReplyKind}
      WHERE m.entity_id = ${executionId}
        AND m.kind = ${requestKind}
        AND m.entity_type IN ${sql.in(types)}
      ORDER BY m.id
    `
    const decoded = yield* decodeRows(rows)

    return yield* Effect.forEach(decoded, (row) =>
      Effect.gen(function* (): Effect.fn.Return<Entry, Schema.SchemaError> {
        const { id } = row
        const described = yield* classify(row, workflow._tag)
        const at = DateTime.makeUnsafe(
          Snowflake.timestamp(Snowflake.Snowflake(id)),
        )
        const exit = row.reply ?? undefined

        return { id, ...described, at, exit }
      }),
    )
  })
}
