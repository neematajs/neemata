import type {
  StoredAttempt,
  StoredChild,
  StoredNode,
  StoredRun,
  StoredSchedule,
} from '../model.ts'
import { STATUSES } from '../model.ts'

/**
 * How records become rows and rows records. The adapter never reads a record:
 * the database takes each column from the record's JSON by field name, and
 * gives rows back as arrays in the order written here.
 */

type Type =
  | 'text'
  | 'uuid'
  | 'int'
  | 'bigint'
  | 'boolean'
  | 'time'
  | 'json'
  | `workflow_${string}`
type Column = readonly [name: string, type: Type]

/**
 * A column for every field, so a field added to a record without one fails
 * the type check instead of being dropped on the way to the database. A
 * nested object is spread over the columns of its fields.
 */
type Columns<Stored> = {
  readonly [Field in keyof Required<Stored>]:
    | Column
    | Readonly<Record<string, Column>>
}

type Field = {
  readonly path: readonly string[]
  readonly column: string
  readonly type: Type
}

const isColumn = (
  spec: Column | Readonly<Record<string, Column>>,
): spec is Column => Array.isArray(spec)

const at = (path: readonly string[]) => `'{${path.join(',')}}'`

/**
 * Where a child stands, as the predicates of the indexes that order a map's
 * children: a statement that reads by them names them so, word for word, for
 * the planner to see that the index serves it.
 */
export const PENDING = `status = '${STATUSES.pending}'`
export const ACTIVE = `status IN (${STATUSES.active
  .map((status) => `'${status}'`)
  .join(', ')})`

/**
 * A time as the store gives it back: whole Unix milliseconds, rounded down.
 * The engine writes whole milliseconds, which stay as they are; a column can
 * still hold microseconds, from `now()` or by hand. Down agrees with filters,
 * which compare a column with whole milliseconds by `<`: a value is below a
 * whole number exactly when its floor is (the `<=` of due schedules takes
 * such a value a millisecond late). Cursors keep the microseconds.
 */
export const millis = (column: string) =>
  `floor(extract(epoch FROM ${column}) * 1000)`

/** The column's value, taken from the record `x`. */
function written({ path, type }: Field) {
  // A JSON `null` is a value and a missing field is none: `#>` keeps them
  // apart where a recordset would make both NULL.
  if (type === 'json') return `x #> ${at(path)}`
  if (type === 'time') {
    return `to_timestamp((x #>> ${at(path)})::float8 / 1000)`
  }
  if (type === 'text') return `x #>> ${at(path)}`
  return `(x #>> ${at(path)})::${type}`
}

/** The field's value in a row array; NULL is a field that is not set. */
function read({ column, type }: Field) {
  // Wrapped for the same reason: unwrapped, a stored JSON `null` and a NULL
  // column would both arrive as `null`.
  if (type === 'json') {
    return `CASE WHEN ${column} IS NULL THEN NULL ELSE jsonb_build_array(${column}) END`
  }
  if (type === 'time') return millis(column)
  return column
}

function table<Stored extends object>(
  name: string,
  key: readonly (keyof Stored & string)[],
  columns: Columns<Stored>,
) {
  const fields = Object.entries<Column | Readonly<Record<string, Column>>>(
    columns,
  ).flatMap(([field, spec]): Field[] =>
    isColumn(spec)
      ? [{ path: [field], column: spec[0], type: spec[1] }]
      : Object.entries(spec).map(([nested, [column, type]]) => ({
          path: [field, nested],
          column,
          type,
        })),
  )
  return rows<Stored>(name, key, fields)
}

function rows<Stored extends object>(
  name: string,
  key: readonly (keyof Stored & string)[],
  fields: readonly Field[],
) {
  const keyFields = key.map(
    (field) => fields.find(({ path }) => path[0] === field)!,
  )
  const keyColumns = keyFields.map(({ column }) => column)
  const names = fields.map(({ column }) => column)
  const row = `jsonb_build_array(${fields.map(read).join(', ')})`

  return {
    /** One row of a `FROM` over the table, as a JSON array. */
    row,
    /** Every such row, as one JSON array of arrays. */
    rows: `coalesce(jsonb_agg(${row} ORDER BY ${keyColumns.join(', ')}), '[]'::jsonb)`,
    /** Writes the records of the JSON array `param`, whole, over their rows. */
    upsert: (param: string) => `
      INSERT INTO ${name} (${names.join(', ')})
      SELECT ${fields.map(written).join(', ')}
      FROM jsonb_array_elements(${param}::jsonb) AS x
      ON CONFLICT (${keyColumns.join(', ')}) DO UPDATE SET
        ${names
          .filter((column) => !keyColumns.includes(column))
          .map((column) => `${column} = EXCLUDED.${column}`)
          .join(', ')}`,
    /**
     * Writes the records of the JSON array `param` over the rows of their
     * keys, and adds none: a record whose row is not there is not written.
     */
    update: (param: string) => `
      UPDATE ${name} AS stored SET
        ${fields
          .filter(({ column }) => !keyColumns.includes(column))
          .map((field) => `${field.column} = ${written(field)}`)
          .join(', ')}
      FROM jsonb_array_elements(${param}::jsonb) AS x
      WHERE ${keyFields
        .map((field) => `stored.${field.column} = ${written(field)}`)
        .join(' AND ')}`,
    decode: (row: readonly unknown[]): Stored => {
      const record: Record<string, any> = {}
      fields.forEach(({ path: [field, nested], type }, index) => {
        const stored = row[index]
        if (stored === null) return
        const value = type === 'json' ? (stored as unknown[])[0] : stored
        if (nested === undefined) record[field!] = value
        else (record[field!] ??= {})[nested] = value
      })
      return record as Stored
    },
    /** The last version of each record: a statement writes a row once. */
    latest: (records: readonly Stored[] = []): readonly Stored[] => {
      const byKey = new Map<string, Stored>()
      for (const record of records) {
        // A tuple as JSON: joined by any separator, two keys could be one.
        const tuple = key.map((field) => record[field])
        byKey.set(JSON.stringify(tuple), record)
      }
      return Array.from(byKey.values())
    },
    /** The same rows without some fields, which are then never read. */
    without: <Left extends keyof Stored & string>(...left: readonly Left[]) =>
      rows<Omit<Stored, Left>>(
        name,
        key as readonly (Exclude<keyof Stored, Left> & string)[],
        fields.filter(({ path }) => !left.some((field) => field === path[0])),
      ),
  }
}

export const runs = table<StoredRun>('workflow_runs', ['id'], {
  id: ['id', 'uuid'],
  kind: ['kind', 'workflow_run_kind'],
  name: ['name', 'text'],
  status: ['status', 'workflow_run_status'],
  input: ['input', 'json'],
  output: ['output', 'json'],
  error: ['error', 'json'],
  parentRunId: ['parent_run_id', 'uuid'],
  parentNodeName: ['parent_node_name', 'text'],
  parentRoute: {
    name: ['parent_route_name', 'text'],
    revision: ['parent_route_revision', 'text'],
  },
  rootRunId: ['root_run_id', 'uuid'],
  tags: ['tags', 'json'],
  idempotencyKey: ['idempotency_key', 'json'],
  unique: {
    key: ['unique_key', 'json'],
    scope: ['unique_scope', 'text'],
    behavior: ['unique_behavior', 'text'],
  },
  revision: ['execution_revision', 'text'],
  graphHash: ['graph_hash', 'text'],
  presentation: ['graph_presentation', 'json'],
  version: ['version', 'int'],
  activeSince: ['active_since', 'time'],
  createdAt: ['created_at', 'time'],
  updatedAt: ['updated_at', 'time'],
})

export const nodes = table<StoredNode>('workflow_nodes', ['runId', 'name'], {
  runId: ['run_id', 'uuid'],
  name: ['name', 'text'],
  kind: ['kind', 'workflow_node_kind'],
  status: ['status', 'workflow_node_status'],
  input: ['input', 'json'],
  output: ['output', 'json'],
  error: ['error', 'json'],
  selectedCase: ['selected_case', 'text'],
  operation: ['operation', 'json'],
  version: ['version', 'int'],
  createdAt: ['created_at', 'time'],
  updatedAt: ['updated_at', 'time'],
})

export const children = table<StoredChild>(
  'workflow_node_children',
  ['runId', 'nodeName', 'childKey'],
  {
    runId: ['run_id', 'uuid'],
    nodeName: ['node_name', 'text'],
    childKey: ['child_key', 'text'],
    kind: ['kind', 'workflow_node_child_kind'],
    status: ['status', 'workflow_node_status'],
    ordinal: ['ordinal', 'int'],
    item: ['item', 'json'],
    input: ['input', 'json'],
    output: ['output', 'json'],
    error: ['error', 'json'],
    childRunId: ['child_run_id', 'uuid'],
    cancellation: ['cancellation', 'text'],
    currentAttemptId: ['current_attempt_id', 'uuid'],
    attemptCount: ['attempt_count', 'int'],
    version: ['version', 'int'],
    createdAt: ['created_at', 'time'],
    updatedAt: ['updated_at', 'time'],
  },
)

/** Runs as a list shows them: payloads stay in the database. */
export const summaries = runs.without('input', 'output', 'presentation')

export const attempts = table<StoredAttempt>('workflow_attempts', ['id'], {
  id: ['id', 'uuid'],
  runId: ['run_id', 'uuid'],
  nodeName: ['node_name', 'text'],
  childKey: ['child_key', 'text'],
  status: ['status', 'workflow_attempt_status'],
  attemptNumber: ['attempt_number', 'int'],
  retryAttemptNumber: ['retry_attempt_number', 'int'],
  input: ['input', 'json'],
  output: ['output', 'json'],
  error: ['error', 'json'],
  dispatchedAt: ['dispatched_at', 'time'],
  completedAt: ['completed_at', 'time'],
})

export const schedules = table<StoredSchedule>('workflow_schedules', ['name'], {
  name: ['name', 'text'],
  runnable: {
    kind: ['runnable_kind', 'workflow_run_kind'],
    name: ['runnable_name', 'text'],
    revision: ['execution_revision', 'text'],
  },
  graphHash: ['graph_hash', 'text'],
  presentation: ['graph_presentation', 'json'],
  input: ['input', 'json'],
  tags: ['tags', 'json'],
  cron: ['cron', 'text'],
  timeZone: ['time_zone', 'text'],
  everyMs: ['every_ms', 'bigint'],
  enabled: ['enabled', 'boolean'],
  nextRunAt: ['next_run_at', 'time'],
  lastSlotAt: ['last_slot_at', 'time'],
  version: ['version', 'int'],
  createdAt: ['created_at', 'time'],
  updatedAt: ['updated_at', 'time'],
})
