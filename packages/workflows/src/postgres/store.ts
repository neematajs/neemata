import { getRandomValues } from 'node:crypto'

import * as Effect from 'effect/Effect'
import * as Latch from 'effect/Latch'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schedule from 'effect/Schedule'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlError from 'effect/sql/SqlError'

import type {
  Command,
  RunRecords,
  RunStatus,
  RunSummary,
  StoredAttempt,
  StoredChild,
  StoredError,
  StoredNode,
  StoredRun,
  Timestamp,
} from '../model.ts'
import type {
  ChildResults,
  ChildSet,
  Claim,
  ClaimOptions,
  DeadCommand,
  Enqueue,
  Family,
  ListedRun,
  Mutation,
  NodeRead,
  OpenRecords,
  Page,
  Plan,
  ReadScope,
  ReleaseOptions,
  RunFilter,
  Snapshot,
  UnitRecords,
} from '../store.ts'
import { StaleClaim, StorageError } from '../errors.ts'
import { MAPS, STATUSES, storedError } from '../model.ts'
import {
  foundRuns,
  linking,
  malformed,
  opened,
  resultsKey,
  Store,
  unitKey,
  unloaded,
  widened,
} from '../store.ts'
import { Notifications } from './notifications.ts'
import {
  ACTIVE,
  attempts,
  children,
  nodes,
  PENDING,
  runs,
  schedules,
  summaries,
} from './records.ts'

/** Nodes as a map's is opened: its input stays in the database. */
const nodesWithoutInput = nodes.without('input')

export type PostgresOptions = {
  /** A command claimed more often than this is set aside as dead. */
  readonly maxDeliveries?: number
  /**
   * Where hints are notified; `CHANNEL` when omitted. A channel is the
   * database's, not a schema's: stores of two schemas in one database hear
   * each other's hints unless their channels differ, which costs them
   * needless claims and nothing else.
   */
  readonly channel?: string
  /**
   * How long the database has to answer each statement of the store, in
   * milliseconds; as long as it takes when omitted. A statement that misses
   * it is cancelled and its operation fails with a `StorageError` whose
   * cause is an `SqlError` of reason `StatementTimeoutError`. Waiting for a
   * guard another transaction holds is waiting for an answer. The statements
   * that begin and end a transaction are the client's, and are not covered.
   */
  readonly answerTimeoutMs?: number
  /**
   * Run with every planned mutation before it is committed, inside its
   * transaction. For tests: it is where a concurrent writer acts.
   */
  readonly beforeCommit?: (mutation: Mutation) => Effect.Effect<unknown>
}

// Node fires a longer timer after 1 ms instead.
const MAX_TIMER_MS = 2_147_483_647
// A longer name is cut by `LISTEN` and refused by `pg_notify`.
const MAX_CHANNEL_BYTES = 63

/** What is wrong with the options, if anything: told when the store is made. */
function invalid({ maxDeliveries, channel, answerTimeoutMs }: PostgresOptions) {
  const whole = (value: number, most: number) =>
    Number.isSafeInteger(value) && value > 0 && value <= most
  if (
    maxDeliveries !== undefined &&
    !whole(maxDeliveries, Number.MAX_SAFE_INTEGER)
  ) {
    return `maxDeliveries [${maxDeliveries}] must be a positive integer`
  }
  if (
    channel !== undefined &&
    (channel === '' ||
      new TextEncoder().encode(channel).length > MAX_CHANNEL_BYTES)
  ) {
    return `channel [${channel}] must be 1 to ${MAX_CHANNEL_BYTES} bytes long`
  }
  if (answerTimeoutMs !== undefined && !whole(answerTimeoutMs, MAX_TIMER_MS)) {
    return `answerTimeoutMs [${answerTimeoutMs}] must be a positive integer of at most ${MAX_TIMER_MS}`
  }
  return undefined
}

/**
 * Where hints are notified by default. The payload says of what: `kind:` and
 * the kind of a command that became due, or `topic:` and a topic a mutation
 * notified.
 */
export const CHANNEL = 'workflow_hints'
const KIND = 'kind:'
const TOPIC = 'topic:'
// A payload the server would refuse must not fail the commit that hints it:
// a longer topic is not hinted, which a hint may always be.
const MAX_TOPIC = 2_000

/**
 * An id as the database gives one back, and the only spelling that names a
 * row. The database would read the same uuid in capitals or without its
 * hyphens: such an id is never sent to it, so that it names nothing here as
 * it names nothing in a store whose ids are plain text.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Time in the first 48 bits and a counter in the next 12, kept as one number
// that only grows: a counter that overflows borrows from the time.
let stamp = 0n

/**
 * A UUIDv7 greater than every one this process made before. Runs made at the
 * same instant are listed in the order of their ids, which is then the order
 * they were made in; it also keeps new rows together in the primary keys.
 */
function nextId() {
  const now = BigInt(Date.now()) << 12n
  stamp = now > stamp ? now : stamp + 1n
  const time = stamp.toString(16).padStart(15, '0')
  const random = getRandomValues(new Uint8Array(8))
  // The two bits that say which layout of UUID this is.
  random[0] = (random[0]! & 0x3f) | 0x80
  const rest = Array.from(random, (byte) => byte.toString(16).padStart(2, '0'))
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${time.slice(12)}-${rest.slice(0, 2).join('')}-${rest.slice(2).join('')}`
}

// Sets travel as JSON text: the drivers agree on nothing else, and an empty
// array has no type one of them could infer.
const json = (value: unknown) => JSON.stringify(value)

/**
 * A statement without its comments, its spaces collapsed. The driver finds
 * a prepared statement by its text, which it hashes at every execution: what
 * only explains a statement would cost at every run of it.
 */
function compact(sql: string) {
  let out = ''
  for (let at = 0; at < sql.length; ) {
    const char = sql[at]!
    if (char === "'" || char === '"') {
      // A quote doubled within is the end of one part and the start of the
      // next, which together are the same text.
      const end = sql.indexOf(char, at + 1) + 1
      out += sql.slice(at, end)
      at = end
    } else if (char === '-' && sql[at + 1] === '-') {
      const end = sql.indexOf('\n', at)
      at = end < 0 ? sql.length : end
    } else if (/\s/.test(char)) {
      while (at < sql.length && /\s/.test(sql[at]!)) at++
      out += ' '
    } else {
      out += char
      at += 1
    }
  }
  return out.trim()
}
const uuids = (param: string) =>
  `ANY(ARRAY(SELECT jsonb_array_elements_text(${param}::jsonb)::uuid))`
const texts = (param: string) =>
  `ANY(ARRAY(SELECT jsonb_array_elements_text(${param}::jsonb)))`
const instant = (param: string) => `to_timestamp(${param}::float8 / 1000)`
const millis = (column: string) => `extract(epoch FROM ${column}) * 1000`
/** A timestamp as a cursor carries it, and back: exact, whatever the session. */
const micros = (column: string) =>
  `(extract(epoch FROM ${column}) * 1000000)::bigint`
const ofMicros = (param: string) =>
  `('epoch'::timestamptz + ${param}::bigint * interval '1 microsecond')`
const lease = (param: string) =>
  `clock_timestamp() + ${param}::float8 * interval '1 millisecond'`
/**
 * A run that has ended, `param` being the statuses that end one. Which those
 * are is the model's to say, and all of a status the statements here know.
 */
const finished = (param: string) => `status::text = ${texts(param)}`
const ENDED = json(STATUSES.terminal)

/**
 * How a command's row says where it is: `lease_token` is set by its first
 * claim and kept, `lease_expires_at` is set while a claim is out. So a
 * command with no token was never claimed, one with a token and no expiry
 * was given back, and a claim holds while the token is its own and the
 * expiry is ahead.
 */
const HELD = 'lease_expires_at > clock_timestamp()'
const NEVER_CLAIMED = 'lease_token IS NULL AND dead_at IS NULL'
const GIVEN_BACK =
  'lease_token IS NOT NULL AND lease_expires_at IS NULL AND dead_at IS NULL'

/**
 * The rows of the claims a statement is to judge, `ids` selecting their ids,
 * locked before any of them is judged. A statement that tests a token and an
 * expiry and then waits for the row tests neither again when the row comes
 * back unchanged: it would act on a lease that ended while it waited, beside
 * the delivery that took the command since. So a claim is judged by the
 * columns of `locked` alone, which are the row's as the lock found it, and
 * against the clock as it is then.
 */
const locked = (ids: string) => `locked AS MATERIALIZED (
    SELECT id, lease_token, lease_expires_at
    FROM workflow_commands
    WHERE id = ANY(ARRAY(${ids}))
    ORDER BY id
    FOR UPDATE
  )`

/** The ids of the claims in the JSON array `param` that hold, of `locked`. */
const holding = (param: string) => `
    SELECT locked.id
    FROM locked, jsonb_array_elements(${param}::jsonb) AS x
    WHERE locked.id = (x->>'id')::uuid
      AND locked.lease_token = x->>'token'
      AND locked.${HELD}`

/**
 * Takes the guard of every name, waiting for whoever holds one. The guards
 * are advisory locks, because a name guards absence too: no row is there to
 * lock for a key nobody holds or a run that does not exist. They are taken
 * in the order of their lock ids, in one statement, at the start of a
 * transaction that holds none: two transactions can never wait on each other.
 *
 * `$1` are the names taken alone; `$2` those taken shared, which only shut
 * out whoever takes them alone. A lock id that both name is taken alone.
 */
const LOCK = compact(`
  SELECT CASE WHEN shared
    THEN pg_advisory_xact_lock_shared(lock)
    ELSE pg_advisory_xact_lock(lock)
  END
  FROM (
    SELECT hashtextextended(name, 0) AS lock, bool_and(shared) AS shared
    FROM (
      SELECT name, false AS shared FROM jsonb_array_elements_text($1::jsonb) AS name
      UNION ALL
      SELECT name, true FROM jsonb_array_elements_text($2::jsonb) AS name
    ) AS named
    GROUP BY 1
    ORDER BY lock
  ) AS ordered`)

/** A dead command as a JSON array, of a `FROM` over the commands. */
const DEAD = `jsonb_build_array(
  id, payload, delivery_count, last_error,
  ${millis('created_at')}, ${millis('dead_at')}
)`

/** The kinds of a map's node, which an open read reads a window of. */
const MAPPED = `kind::text IN (${MAPS.map((kind) => `'${kind}'`).join(', ')})`

/**
 * The children an open read reads, as `selected`: of each run opened, `runs`
 * a parameter as `$10` of a load is, the nodes that have not ended by
 * `ended`, and of each its children, a map's in its window. Each as a `row`
 * when `rows` says so, or else by its keys, its status and its run alone.
 */
const selection = (
  runs: string,
  ended: string,
  rows = true,
) => `opening AS MATERIALIZED (
    -- By the keys of each table, as a list of them: a prepared statement's
    -- plan takes a parameter's list for a hundred, and would scan a table
    -- of fewer rows than that whole, every pass, however large it grows.
    SELECT run.id AS run_id, (
        SELECT x->1 FROM jsonb_array_elements(${runs}::jsonb) AS x
        WHERE (x->>0)::uuid = run.id LIMIT 1
      ) AS maps
    FROM workflow_runs AS run
    WHERE run.id = ANY(ARRAY(
      SELECT (x->>0)::uuid FROM jsonb_array_elements(${runs}::jsonb) AS x
    ))
  ), opened AS MATERIALIZED (
    SELECT node.run_id, node.name, node.${MAPPED} AS mapped,
      map.named IS NOT NULL AS named, map.lim
    FROM workflow_nodes AS node
    JOIN opening ON opening.run_id = node.run_id
    LEFT JOIN LATERAL (
      -- Wide enough for any limit a plan names, and for one more.
      SELECT true AS named, (m->>1)::bigint AS lim
      FROM jsonb_array_elements(opening.maps) AS m
      WHERE m->>0 = node.name
      LIMIT 1
    ) AS map ON true
    WHERE node.run_id = ANY(ARRAY(SELECT run_id FROM opening))
      AND NOT node.${finished(ended)}
  ), selected AS MATERIALIZED (
    -- Each arm by an index of its own, each read as far as it is asked.
    SELECT opened.run_id, opened.name AS node_name, child.*
    FROM opened CROSS JOIN LATERAL (
      SELECT ${rows ? children.row : 'NULL::jsonb'} AS row, ordinal, child_key,
        current_attempt_id, child_run_id, status, false AS beyond
      FROM workflow_node_children
      WHERE NOT opened.mapped
        AND run_id = opened.run_id AND node_name = opened.name
      UNION ALL
      SELECT ${rows ? children.row : 'NULL'}, ordinal, child_key,
        current_attempt_id, child_run_id, status, false
      FROM workflow_node_children
      WHERE opened.mapped AND opened.named
        AND run_id = opened.run_id AND node_name = opened.name AND ${ACTIVE}
      UNION ALL (
        -- One past the limit only tells that more wait: \`beyond\`, it is
        -- given for that alone, and nothing of it is read.
        SELECT ${rows ? children.row : 'NULL'}, ordinal, child_key,
          current_attempt_id, child_run_id, status,
          coalesce(row_number() OVER (ORDER BY ordinal, child_key) > opened.lim, false)
        FROM workflow_node_children
        WHERE opened.mapped AND opened.named
          AND run_id = opened.run_id AND node_name = opened.name AND ${PENDING}
        ORDER BY ordinal, child_key
        LIMIT opened.lim + 1
      )
    ) AS child
  )`

/**
 * `LOCK` for a scope that opens runs, which takes the guards of the runs of
 * their children too: those an open read will read that have not ended,
 * whose heads a pass observes. They are found as the statement begins, and
 * guarded with the rest, in one order, before anything waits: so no plan
 * asks for them after it is shown its run, in a transaction of its own. The
 * statement sees the children as they were when it began: one linked while
 * it waited, by a pass it waited for, is left to the load.
 *
 * `$1` and `$2` as of `LOCK`, `$3` the runs opened, `$4` the statuses that
 * end a run. Answers with the runs it guarded, as `[runId, linkedRunId]`.
 */
const LOCK_OPEN = compact(`
  WITH ${selection('$3', '$4', false)}, linked AS MATERIALIZED (
    SELECT DISTINCT run_id, child_run_id FROM selected
    WHERE child_run_id IS NOT NULL AND NOT beyond AND NOT ${finished('$4')}
  ), guarded AS MATERIALIZED (
    SELECT CASE WHEN shared
      THEN pg_advisory_xact_lock_shared(lock)
      ELSE pg_advisory_xact_lock(lock)
    END
    FROM (
      SELECT hashtextextended(name, 0) AS lock, bool_and(shared) AS shared
      FROM (
        SELECT name, false AS shared FROM jsonb_array_elements_text($1::jsonb) AS name
        UNION ALL
        -- As \`runGuard\` spells the guard of a run.
        SELECT 'run:' || child_run_id, false FROM linked
        UNION ALL
        SELECT name, true FROM jsonb_array_elements_text($2::jsonb) AS name
      ) AS named
      GROUP BY 1
      ORDER BY lock
    ) AS ordered
  )
  SELECT (SELECT count(*)::int FROM guarded) AS guarded,
    (SELECT coalesce(jsonb_agg(jsonb_build_array(run_id, child_run_id)), '[]'::jsonb)
     FROM linked) AS linked`)

/** The parameters of a load, by what each carries. */
type LoadParam =
  | 'records'
  | 'whole'
  | 'keys'
  | 'definitions'
  | 'schedules'
  | 'scheduleNames'
  | 'families'
  | 'ended'
  | 'units'
  | 'open'
  | 'results'
  | 'dead'
  | 'guarded'

/**
 * What of a load a scope asks for, beyond what every load reads: a part it
 * does not ask for is not in the statement. The database plans and runs
 * all of one, empty or not, and most transactions ask for one part at most.
 */
type LoadShape = {
  /** Whether the load is a transaction's, which holds what it is shown. */
  readonly held: boolean
  readonly units: boolean
  readonly open: boolean
  /** Whether the runs of the children of runs opened are read, held. */
  readonly linked: boolean
  readonly results: boolean
}

/**
 * The statement of a load of one shape, with its parameters in the order
 * the text first names them: a parameter it never names would have no type
 * the database could tell.
 *
 * Its parameters: `records` run records, `whole` the runs loaded whole,
 * `keys`, `definitions`, `schedules`, whether `scheduleNames`, the roots of
 * `families`, the statuses that have `ended` a run, `units`, runs `open`,
 * nodes whose `results` are read, and when the load is a transaction's, the
 * ids of `dead` commands and the runs of children that `LOCK_OPEN`
 * `guarded`.
 *
 * A unit is `[runId, nodeName, childKey, attempt]`, where `attempt` is an
 * attempt's id, `null` for the child's current one, or `false` for an id no
 * row can have. Each of its records is found by its key alone, and the
 * attempt only under the child the unit names. Its run is among `records`.
 *
 * A run opened is `[runId, maps]`, each map `[nodeName, limit]` and `limit`
 * `null` for all: its nodes, a map's without its input, and of each node
 * that has not ended its children, by an index of its own: those of a map
 * under way, and one more of those waiting than its limit, which tells
 * whether more wait; all of any other. A map not named has none read. Then
 * the current attempts of the children read, by id. A node whose results
 * are read is `[runId, nodeName]`: the node whole and all its children by
 * ordinal. The runs of both are among `records`. A transaction's load shows
 * each run opened the runs of its children read that have not ended, held
 * as heads, when its read asks for them: those `LOCK_OPEN` guarded, and
 * those linked since whose guard it takes without waiting. One whose guard
 * another holds is not shown.
 *
 * A transaction holds the rows it loads, as well as their guards. A guard
 * keeps out whoever names what it guards, and the removal of a family names
 * only its root: the runs under it, with what they own and the keys they
 * hold, go by the foreign keys. A key share of a row is what a deletion
 * waits for, so a family is not removed under a plan that loaded a run or a
 * key of it, and a plan that comes after is shown them gone.
 *
 * The parents of the runs loaded are held too, and not shown: a run that
 * ends wakes its parent unread, and the foreign key of that command takes a
 * key share of the parent at the commit. Taken there, it would wait for a
 * removal that holds the parent and waits for the run: so it is taken here,
 * with the rest.
 *
 * They are held in the order a removal holds them: roots first, then the
 * runs under them, each by id. By id alone, a run that sorts before its root,
 * as ids made before generation 6 may, would be held before the root a
 * removal holds while it waits for that run.
 */
function load({ held, units, open, linked, results }: LoadShape) {
  const params: LoadParam[] = []
  // Numbered as the statement is made: the text may name them in any order.
  const $ = (name: LoadParam) => {
    const at = params.indexOf(name)
    return `$${at < 0 ? params.push(name) : at + 1}`
  }
  const ofTaken = linked ? ' UNION ALL SELECT child_run_id FROM taken' : ''
  const ctes = [
    ...(open ? [selection($('open'), $('ended'))] : []),
    ...(linked
      ? [
          `linked AS MATERIALIZED (
    SELECT DISTINCT run_id, child_run_id FROM selected
    WHERE child_run_id IS NOT NULL AND NOT beyond AND NOT ${finished($('ended'))}
  ), taken AS MATERIALIZED (
    -- Guarded already, or linked since the guards were chosen and guarded
    -- now if nobody holds them: tried, never waited for, so no order of
    -- locks is broken. One held elsewhere is not shown.
    SELECT run_id, child_run_id FROM linked
    WHERE child_run_id = ${uuids($('guarded'))}
      OR pg_try_advisory_xact_lock(hashtextextended('run:' || child_run_id, 0))
  )`,
        ]
      : []),
    ...(held
      ? [
          `shown AS MATERIALIZED (
    SELECT jsonb_array_elements_text(${$('records')}::jsonb)::uuid AS id${ofTaken}
  ), held AS MATERIALIZED (
    -- One list of ids, which the primary key finds: of several lists, each
    -- one more condition, the table would be scanned.
    SELECT * FROM workflow_runs
    WHERE id = ANY(ARRAY(
      SELECT id FROM shown
      UNION ALL
      SELECT parent_run_id FROM workflow_runs
      WHERE id = ANY(ARRAY(SELECT id FROM shown))
    ))
    ORDER BY parent_run_id IS NOT NULL, id
    FOR KEY SHARE
  ), head AS (
    SELECT * FROM held WHERE id = ANY(ARRAY(SELECT id FROM shown))
  ), holder AS MATERIALIZED (
    SELECT * FROM workflow_keys WHERE key = ${texts($('keys'))}
    ORDER BY key
    FOR KEY SHARE
  ), asked AS MATERIALIZED (
    -- A command has no name to guard: its id is the database's, so one that
    -- is absent never appears, and one that is there is held as a row, dead
    -- or not. Nothing then sets it aside, takes it away or claims it before
    -- the commit.
    SELECT * FROM workflow_commands WHERE id = ${uuids($('dead'))}
    ORDER BY id
    FOR UPDATE
  )`,
        ]
      : []),
  ]
  const text = `${ctes.length > 0 ? `WITH ${ctes.join(', ')}` : ''}
  SELECT jsonb_build_object(
    'now', floor(${millis('clock_timestamp()')}),
    'runs', (SELECT ${runs.rows} FROM ${
      held ? 'head' : `workflow_runs WHERE id = ${uuids($('records'))}`
    }),
    'nodes', (SELECT ${nodes.rows} FROM workflow_nodes WHERE run_id = ${uuids($('whole'))}),
    'children', (SELECT ${children.rows} FROM workflow_node_children WHERE run_id = ${uuids($('whole'))}),
    'attempts', (SELECT ${attempts.rows} FROM workflow_attempts WHERE run_id = ${uuids($('whole'))}),
    'units', ${
      units
        ? `(
      SELECT coalesce(jsonb_agg(jsonb_build_array(
        (SELECT ${nodes.row} FROM workflow_nodes
         WHERE run_id = (unit->>0)::uuid AND name = unit->>1),
        (SELECT ${children.row} FROM workflow_node_children
         WHERE run_id = (unit->>0)::uuid AND node_name = unit->>1
           AND child_key = unit->>2),
        (SELECT ${attempts.row} FROM workflow_attempts
         WHERE id = CASE jsonb_typeof(unit->3)
             WHEN 'string' THEN (unit->>3)::uuid
             WHEN 'null' THEN (
               SELECT current_attempt_id FROM workflow_node_children
               WHERE run_id = (unit->>0)::uuid AND node_name = unit->>1
                 AND child_key = unit->>2)
           END
           AND run_id = (unit->>0)::uuid AND node_name = unit->>1
           AND child_key = unit->>2)
      ) ORDER BY place), '[]'::jsonb)
      FROM jsonb_array_elements(${$('units')}::jsonb) WITH ORDINALITY AS asked(unit, place)
    )`
        : `'[]'::jsonb`
    },
    'open', ${
      open
        ? `(
      SELECT coalesce(jsonb_agg(jsonb_build_array(
        opening.run_id,
        -- A map's columns but its input: the input is never read.
        (SELECT coalesce(jsonb_agg(CASE WHEN node.${MAPPED}
            THEN jsonb_build_array(false, ${nodesWithoutInput.row})
            ELSE jsonb_build_array(true, ${nodes.row})
          END), '[]'::jsonb)
         FROM workflow_nodes AS node WHERE node.run_id = opening.run_id),
        (SELECT coalesce(jsonb_agg(jsonb_build_array(opened.name, (
            SELECT coalesce(jsonb_agg(selected.row
              ORDER BY selected.ordinal, selected.child_key), '[]'::jsonb)
            FROM selected
            WHERE selected.run_id = opened.run_id
              AND selected.node_name = opened.name
          ), opened.mapped)), '[]'::jsonb)
         FROM opened
         WHERE opened.run_id = opening.run_id
           AND (NOT opened.mapped OR opened.named)),
        (SELECT ${attempts.rows} FROM workflow_attempts
         WHERE id = ANY(ARRAY(
             SELECT current_attempt_id FROM selected
             WHERE selected.run_id = opening.run_id AND NOT selected.beyond
               AND current_attempt_id IS NOT NULL))
           AND run_id = opening.run_id)
      )), '[]'::jsonb)
      FROM opening
    )`
        : `'[]'::jsonb`
    },
    'results', ${
      results
        ? `(
      SELECT coalesce(jsonb_agg(jsonb_build_array(
        (SELECT ${nodes.row} FROM workflow_nodes
         WHERE run_id = (node->>0)::uuid AND name = node->>1),
        (SELECT coalesce(jsonb_agg(${children.row}
            ORDER BY ordinal, child_key), '[]'::jsonb)
         FROM workflow_node_children
         WHERE run_id = (node->>0)::uuid AND node_name = node->>1)
      ) ORDER BY place), '[]'::jsonb)
      FROM jsonb_array_elements(${$('results')}::jsonb) WITH ORDINALITY AS wanted(node, place)
    )`
        : `'[]'::jsonb`
    },
    'keys', (SELECT coalesce(jsonb_agg(jsonb_build_array(key, run_id)), '[]'::jsonb)
             FROM ${held ? 'holder' : `workflow_keys WHERE key = ${texts($('keys'))}`}),
    'definitions', (SELECT coalesce(jsonb_agg(jsonb_build_array(key, value)), '[]'::jsonb)
                    FROM workflow_definitions WHERE key = ${texts($('definitions'))}),
    'schedules', (SELECT ${schedules.rows} FROM workflow_schedules WHERE name = ${texts($('schedules'))}),
    'scheduleNames', CASE WHEN ${$('scheduleNames')}::boolean THEN (
      SELECT coalesce(jsonb_agg(name), '[]'::jsonb) FROM workflow_schedules
    ) END,
    -- Counted where they are: no run under a root comes to the process.
    'families', (
      SELECT coalesce(jsonb_agg(jsonb_build_array(
        ${summaries.row},
        (SELECT count(*) FROM workflow_runs AS member
         WHERE member.root_run_id = root.id),
        (SELECT count(*) FROM workflow_runs AS member
         WHERE member.root_run_id = root.id AND NOT member.${finished($('ended'))}),
        (SELECT member.id FROM workflow_runs AS member
         WHERE member.root_run_id = root.id AND NOT member.${finished($('ended'))}
         LIMIT 1),
        (SELECT command.run_id
         FROM workflow_commands AS command
         JOIN workflow_runs AS member ON member.id = command.run_id
         WHERE member.root_run_id = root.id AND command.${HELD}
         LIMIT 1)
      )), '[]'::jsonb)
      FROM workflow_runs AS root WHERE root.id = ${uuids($('families'))}
    ),
    'linked', ${
      linked
        ? `(SELECT coalesce(jsonb_agg(jsonb_build_array(run_id, child_run_id)), '[]'::jsonb)
            FROM taken)`
        : `'[]'::jsonb`
    },
    'dead', ${
      held
        ? `(SELECT coalesce(jsonb_agg(${DEAD}), '[]'::jsonb)
            FROM asked WHERE dead_at IS NOT NULL)`
        : `'[]'::jsonb`
    }
  ) AS loaded`
  return { text: compact(text), params }
}

/** Each shape's statement, made when a load first takes that shape. */
const loads = new Map<string, ReturnType<typeof load>>()
const loadOf = (shape: LoadShape) => {
  const { held, units, open, linked, results } = shape
  const key = `${+held}${+units}${+open}${+linked}${+results}`
  let statement = loads.get(key)
  if (!statement) {
    statement = load(shape)
    loads.set(key, statement)
  }
  return statement
}

type Loaded = {
  readonly now: Timestamp
  readonly runs: readonly unknown[][]
  readonly nodes: readonly unknown[][]
  readonly children: readonly unknown[][]
  readonly attempts: readonly unknown[][]
  /** Of each unit asked, in order: its node, child and attempt rows. */
  readonly units: readonly (readonly [
    node: unknown[] | null,
    child: unknown[] | null,
    attempt: unknown[] | null,
  ])[]
  /** The runs of children read that the load guarded, as `LOCK_OPEN` gives them. */
  readonly linked: readonly Linked[]
  /** Of each run opened that exists. */
  readonly open: readonly (readonly [
    runId: string,
    nodes: readonly (readonly [whole: boolean, node: unknown[]])[],
    childSets: readonly (readonly [
      nodeName: string,
      children: readonly unknown[][],
      mapped: boolean,
    ])[],
    attempts: readonly unknown[][],
  ])[]
  /** Of each node asked, in order: its row and its children's. */
  readonly results: readonly (readonly [
    node: unknown[] | null,
    children: readonly unknown[][],
  ])[]
  readonly keys: readonly (readonly [key: string, runId: string])[]
  readonly definitions: readonly (readonly [key: string, value: unknown])[]
  readonly schedules: readonly unknown[][]
  readonly scheduleNames: readonly string[] | null
  readonly families: readonly (readonly [
    root: readonly unknown[],
    size: number,
    active: number,
    activeRunId: string | null,
    claimedRunId: string | null,
  ])[]
  readonly dead: readonly DeadRow[]
}

type DeadRow = readonly [
  id: string,
  command: Command,
  deliveries: number,
  error: StoredError | null,
  createdAt: Timestamp,
  deadAt: Timestamp,
]

function deadCommand(row: DeadRow): DeadCommand {
  const [id, command, deliveries, error, createdAt, deadAt] = row
  return {
    id,
    command,
    deliveries,
    ...(error === null ? {} : { error }),
    createdAt,
    deadAt,
  }
}

/** The parameters of a commit, by what each carries. */
type CommitParam =
  | 'acks'
  | 'holds'
  | 'runs'
  | 'found'
  | 'nodes'
  | 'kept'
  | 'attempts'
  | 'children'
  | 'released'
  | 'acquired'
  | 'definitions'
  | 'schedules'
  | 'unschedule'
  | 'removed'
  | 'enqueue'
  | 'now'
  | 'channel'
  | 'topics'

/**
 * Which parts of a commit a mutation has: one it has nothing for is not in
 * the statement, which the database would plan and run all of, empty or
 * not. Most commits write a few records and queue a command.
 */
type CommitShape = {
  readonly claims: boolean
  readonly runs: boolean
  readonly nodes: boolean
  readonly kept: boolean
  readonly attempts: boolean
  readonly children: boolean
  readonly released: boolean
  readonly acquired: boolean
  readonly definitions: boolean
  readonly schedules: boolean
  readonly unschedule: boolean
  readonly removed: boolean
  readonly enqueue: boolean
  readonly topics: boolean
}

/**
 * A whole mutation in one statement: its parts see one state, and foreign
 * keys are checked when all of it is written, so a run may arrive with the
 * node of its parent that it hangs on. What it reports is checked afterwards,
 * and a failed check rolls the statement back.
 *
 * Its parameters, numbered as the statement is made: `acks` and `holds`,
 * claims to remove and to keep, `runs` and the runs `found` by the plan's
 * reads, `nodes`, nodes `kept` but for their input, `attempts`, `children`,
 * keys `released` and `acquired`, `definitions`, `schedules`, schedules to
 * `unschedule`, the roots of families `removed`, commands to `enqueue` as of
 * `now`, and the hint `channel` with the `topics` hinted on it.
 */
function commit(shape: CommitShape) {
  const params: CommitParam[] = []
  const $ = (name: CommitParam) => {
    const at = params.indexOf(name)
    return `$${at < 0 ? params.push(name) : at + 1}`
  }
  const parts: string[] = []
  if (shape.claims) {
    parts.push(`${locked(`
      SELECT (x->>'id')::uuid
      FROM jsonb_array_elements(${$('acks')}::jsonb || ${$('holds')}::jsonb) AS x`)}, acked AS (
    DELETE FROM workflow_commands
    WHERE id = ANY(ARRAY(${holding($('acks'))}))
    RETURNING id
  ), held AS (
    -- Kept, and locked: no claim takes one over before the commit.${holding($('holds'))}
  )`)
  }
  if (shape.runs) {
    parts.push(`run AS (
    -- A run that exists is written only when the plan had it loaded.
    ${runs.upsert($('runs'))}
    WHERE workflow_runs.id = ${uuids($('found'))}
    RETURNING id
  )`)
  }
  if (shape.nodes) parts.push(`node AS (${nodes.upsert($('nodes'))})`)
  if (shape.kept) {
    parts.push(`kept AS (
    -- Over rows that exist, never adding one, and with no word of input.${nodesWithoutInput.update($('kept'))}
    RETURNING 1
  )`)
  }
  if (shape.attempts) {
    parts.push(`attempt AS (${attempts.upsert($('attempts'))})`)
  }
  if (shape.children) {
    parts.push(`child AS (${children.upsert($('children'))})`)
  }
  if (shape.released) {
    parts.push(`released AS (
    DELETE FROM workflow_keys WHERE key = ${texts($('released'))}
  )`)
  }
  if (shape.acquired) {
    parts.push(`acquired AS (
    INSERT INTO workflow_keys (key, run_id)
    SELECT x->>'key', (x->>'runId')::uuid
    FROM jsonb_array_elements(${$('acquired')}::jsonb) AS x
    ON CONFLICT (key) DO UPDATE SET run_id = EXCLUDED.run_id
  )`)
  }
  if (shape.definitions) {
    parts.push(`saved AS (
    INSERT INTO workflow_definitions (key, value)
    SELECT x->>'key', x->'value'
    FROM jsonb_array_elements(${$('definitions')}::jsonb) AS x
    ON CONFLICT (key) DO NOTHING
    RETURNING key
  )`)
  }
  if (shape.schedules) {
    parts.push(`scheduled AS (${schedules.upsert($('schedules'))})`)
  }
  if (shape.unschedule) {
    parts.push(`unscheduled AS (
    DELETE FROM workflow_schedules WHERE name = ${texts($('unschedule'))}
  )`)
  }
  if (shape.removed) {
    parts.push(`removed AS (
    -- What the runs own, the keys they hold and their commands go with them,
    -- by the foreign keys of each.
    DELETE FROM workflow_runs WHERE root_run_id = ${uuids($('removed'))}
  )`)
  }
  if (shape.enqueue) {
    const now = instant($('now'))
    const wanted = $('enqueue')
    parts.push(`revived AS (
    -- A command queued again for the same work is what decides it now,
    -- whether it is queued or skipped: the dead ones with its key go.
    DELETE FROM workflow_commands
    WHERE dead_at IS NOT NULL
      AND dedupe IN (
        SELECT x->>'dedupe' FROM jsonb_array_elements(${wanted}::jsonb) AS x
      )
  ), enqueued AS (
    INSERT INTO workflow_commands (
      kind, run_id, name, revision, payload, dedupe, run_at, created_at
    )
    SELECT
      x->'command'->>'kind',
      (x->'command'->>'runId')::uuid,
      x->'command'->>'name',
      x->'command'->>'revision',
      x->'command',
      x->>'dedupe',
      coalesce(${instant(`(x->>'availableAt')`)}, ${now}),
      ${now}
    FROM jsonb_array_elements(${wanted}::jsonb) WITH ORDINALITY AS wanted(x, position)
    -- Skipped while an unclaimed command with the key waits: one never
    -- claimed, or one given back. A claimed one is found by neither.
    WHERE NOT EXISTS (
      SELECT FROM workflow_commands AS waiting
      WHERE waiting.dedupe = x->>'dedupe' AND ${NEVER_CLAIMED}
    ) AND NOT EXISTS (
      SELECT FROM workflow_commands AS waiting
      WHERE waiting.dedupe = x->>'dedupe' AND ${GIVEN_BACK}
    )
    ORDER BY position
    -- Two commits that share no guard see neither's command above. The
    -- unique index over commands never claimed lets one of them through, and
    -- the other meets there the command that waits: one \`hastened\` below
    -- cannot see, as it was not there when this statement began. It is made
    -- due no later than the one it keeps from being added, here.
    ON CONFLICT (dedupe) WHERE ${NEVER_CLAIMED} DO UPDATE
      SET run_at = EXCLUDED.run_at
      WHERE workflow_commands.run_at > EXCLUDED.run_at
    RETURNING dedupe
  ), hastened AS (
    -- The command that waits, the first queued of them, is due no later
    -- than the one it kept from being added would have been.
    UPDATE workflow_commands AS waiting
    SET run_at = wanted.run_at
    FROM (
      SELECT x->>'dedupe' AS dedupe,
             coalesce(${instant(`(x->>'availableAt')`)}, ${now}) AS run_at
      FROM jsonb_array_elements(${wanted}::jsonb) AS x
    ) AS wanted
    WHERE waiting.id = (
        -- One arm for each index that finds a command by its key.
        SELECT id FROM (
          SELECT id, seq FROM workflow_commands
          WHERE dedupe = wanted.dedupe AND ${NEVER_CLAIMED}
          UNION ALL
          SELECT id, seq FROM workflow_commands
          WHERE dedupe = wanted.dedupe AND ${GIVEN_BACK}
        ) AS unclaimed
        ORDER BY seq
        LIMIT 1
      )
      AND waiting.run_at > wanted.run_at
      -- Judged again as it is, when a claimer took it while this waited.
      AND waiting.dead_at IS NULL
      AND (waiting.lease_token IS NULL OR waiting.lease_expires_at IS NULL)
  )`)
  }
  if (shape.enqueue || shape.topics) {
    // Of every command wanted now, and every one not added, whenever wanted:
    // one not added may have met the command that waits at the index, which
    // held it to this commit, and a claimer woken by the commit that queued
    // it passed over it then. What waits may be due though this one is not,
    // and only this commit can say so. The commits of two children that end
    // at once each wake their parent so. A hint for nothing due costs a
    // claim that finds nothing.
    const hints = [
      ...(shape.enqueue
        ? [
            `SELECT '${KIND}' || (x->'command'->>'kind') AS hint
      FROM jsonb_array_elements(${$('enqueue')}::jsonb) AS x
      WHERE coalesce(${instant(`(x->>'availableAt')`)}, ${instant($('now'))})
          <= ${instant($('now'))}
        OR x->>'dedupe' NOT IN (SELECT dedupe FROM enqueued)`,
          ]
        : []),
      ...(shape.topics
        ? [`SELECT jsonb_array_elements_text(${$('topics')}::jsonb) AS hint`]
        : []),
    ]
    parts.push(`hinted AS (
    -- Delivered when the transaction commits, and not at all otherwise.
    SELECT pg_notify(${$('channel')}, hint)
    FROM (
      ${hints.join('\n      UNION\n      ')}
    ) AS hints
  )`)
  }
  const ids = (cte: string, column: string, present: boolean) =>
    present
      ? `(SELECT coalesce(jsonb_agg(${column}), '[]'::jsonb) FROM ${cte})`
      : `'[]'::jsonb`
  const count = (cte: string, present: boolean) =>
    present ? `(SELECT count(*)::int FROM ${cte})` : '0'
  const text = `${parts.length > 0 ? `WITH ${parts.join(', ')}` : ''}
  SELECT
    ${ids('acked', 'id', shape.claims)} AS acked,
    ${ids('held', 'id', shape.claims)} AS held,
    ${ids('run', 'id', shape.runs)} AS runs,
    ${ids('saved', 'key', shape.definitions)} AS saved,
    ${count('kept', shape.kept)} AS kept,
    ${count('hinted', shape.enqueue || shape.topics)} AS hinted`
  return { text: compact(text), params }
}

/** Each shape's statement, made when a commit first takes that shape. */
const commits = new Map<string, ReturnType<typeof commit>>()
const commitOf = (shape: CommitShape) => {
  const key = Object.values(shape)
    .map((part) => +part)
    .join('')
  let statement = commits.get(key)
  if (!statement) {
    statement = commit(shape)
    commits.set(key, statement)
  }
  return statement
}

/**
 * How the families a mutation was planned on are held to its commit. The
 * runs under a root have guards of their own, which a family does not take,
 * so rows are locked instead, in three statements: under `READ COMMITTED`
 * each sees what the one before it waited for.
 *
 * The roots first. A run enters a family holding a key share of its root,
 * for the foreign key, so this waits for every run on its way in, and none
 * enters after. `$1` the roots of families.
 */
const HOLD_ROOTS = compact(`
  SELECT id FROM workflow_runs WHERE id = ${uuids('$1')}
  ORDER BY id
  FOR UPDATE`)

/**
 * Then every run under them, which waits for whoever writes one or has one
 * loaded.
 */
const HOLD_MEMBERS = compact(`
  SELECT id FROM workflow_runs WHERE root_run_id = ${uuids('$1')}
  ORDER BY id
  FOR UPDATE`)

/**
 * Then they are counted, as they now stay. `$1` the roots of families, `$2`
 * the statuses that end a run.
 */
const COUNT = compact(`
  SELECT root_run_id AS root, count(*)::int AS size,
         (count(*) FILTER (WHERE NOT ${finished('$2')}))::int AS active
  FROM workflow_runs WHERE root_run_id = ${uuids('$1')}
  GROUP BY root_run_id`)

/**
 * The first commands that may be claimed now of each route in `routes`, in
 * the order they were queued: `selected` of what `first` takes of them.
 * `workflow_commands_lane_idx` holds a lane in that order, so each route reads
 * the head of its own lane and no other command. A revision is matched by
 * one of two arms, as an index can match it.
 *
 * `first` is given the lane in its order, as far as twice the limit: a
 * number the planner knows, which is what makes it read the index in order
 * instead of sorting the lane.
 */
const heads = (
  routes: string,
  selected: string,
  first: (lane: string) => string = (lane) => lane,
) =>
  [true, false]
    .map(
      (versioned) => `
  SELECT ${selected}
  FROM ${routes} AS route
  CROSS JOIN LATERAL (${first(`
    SELECT command.id, command.seq, command.delivery_count
    FROM workflow_commands AS command
    WHERE command.kind = route.kind
      AND command.name = route.name
      AND command.revision ${versioned ? '= route.revision' : 'IS NULL'}
      AND command.dead_at IS NULL
      AND command.run_at <= (SELECT now FROM clock)
      AND (command.lease_expires_at IS NULL
           OR command.lease_expires_at <= (SELECT now FROM clock))
    -- All of one revision, or of none: the order is that of \`seq\`, named
    -- as the index has it, which the planner needs to see for a lane of none.
    ORDER BY command.revision, command.seq
    LIMIT 2 * $2::int`)}
  ) AS due
  -- A route without a revision is the unversioned lane, never a wildcard.
  WHERE route.revision IS ${versioned ? 'NOT NULL' : 'NULL'}`,
    )
    .join('\n  UNION ALL')

/**
 * `$1` lanes, `$2` limit, `$3` lease, `$4` deliveries allowed.
 *
 * In two steps. The heads of the lanes are read without a lock, to see how
 * many commands of each lane are among the first the claim may take, with
 * those before them that were delivered too often. Then each lane is read
 * again for that many and they are locked, passing over what another
 * claimer holds: so a claim locks no more than it takes, and one that finds
 * rows taken goes on to the next of the same lane.
 *
 * What a claim reads and sets aside is bounded by its limit: a lane gives
 * twice the limit at most. So when more of a lane's first commands than that
 * were delivered too often, a claim takes fewer than it could, and the next
 * one goes on from there.
 */
export const CLAIM = compact(`
  WITH clock AS MATERIALIZED (
    -- Sampled once: every row is judged at the same instant, which is the
    -- present even late in a transaction of the caller's.
    SELECT clock_timestamp() AS now
  ), served AS MATERIALIZED (
    SELECT DISTINCT lane->>'kind' AS kind, route->>'name' AS name,
                    route->>'revision' AS revision
    FROM jsonb_array_elements($1::jsonb) AS lane,
      jsonb_array_elements(lane->'routes') AS route
  ), head AS MATERIALIZED (${heads(
    'served',
    'route.kind, route.name, route.revision, due.seq, due.delivery_count >= $4 AS spent',
  )}
  ), share AS MATERIALIZED (
    -- In the order queued, whatever the lane: one with many waiting
    -- commands starves no other. A command set aside takes no place.
    SELECT kind, name, revision, count(*) AS take
    FROM (
      SELECT *, count(*) FILTER (WHERE NOT spent) OVER (ORDER BY seq) AS place
      FROM head
    ) AS placed
    WHERE place < $2::int OR (place = $2::int AND NOT spent)
    GROUP BY kind, name, revision
  ), reached AS MATERIALIZED (${heads(
    'share',
    'due.id, due.seq, due.delivery_count',
    // A row is locked as it is read, and the read ends with the lane's
    // share. One that another claimer changed since this statement began
    // is judged again as it is, so no command is claimed twice.
    (lane) => `
    SELECT * FROM (${lane}
      FOR UPDATE SKIP LOCKED
    ) AS free
    LIMIT route.take`,
  )}
  ), buried AS (
    -- By their ids as an array, here and below: found one by one by the
    -- primary key, however many the planner guesses there are.
    UPDATE workflow_commands
    SET dead_at = (SELECT now FROM clock)
    WHERE id = ANY(ARRAY(SELECT id FROM reached WHERE delivery_count >= $4))
  ), picked AS (
    SELECT id FROM reached
    WHERE delivery_count < $4
    ORDER BY seq
    LIMIT $2::int
  ), claimed AS (
    UPDATE workflow_commands AS command
    SET lease_token = gen_random_uuid()::text,
        lease_expires_at = (SELECT now FROM clock)
          + $3::float8 * interval '1 millisecond',
        delivery_count = command.delivery_count + 1
    WHERE command.id = ANY(ARRAY(SELECT id FROM picked))
    RETURNING command.id, command.seq, command.lease_token, command.payload,
              command.delivery_count
  )
  SELECT id, lease_token AS token, payload AS command, delivery_count AS deliveries
  FROM claimed
  ORDER BY seq`)

/** `$1` id, `$2` token, `$3` delay, `$4` error, `$5` the hint channel. */
const RELEASE = compact(`
  WITH ${locked('SELECT $1::uuid')}, released AS (
    UPDATE workflow_commands
    SET lease_expires_at = NULL,
        run_at = ${lease('$3')},
        -- Only a delivery that failed counts against the command.
        delivery_count = delivery_count
          - CASE WHEN $4::jsonb IS NULL THEN 1 ELSE 0 END,
        last_error = coalesce($4::jsonb, last_error)
    WHERE id = (SELECT id FROM locked WHERE lease_token = $2 AND ${HELD})
    RETURNING kind
  ), hinted AS (
    SELECT pg_notify($5, '${KIND}' || kind)
    FROM released WHERE $3::float8 <= 0
  )
  SELECT
    (SELECT count(*)::int FROM released) AS released,
    (SELECT count(*)::int FROM hinted) AS hinted`)

/**
 * `$1` id, `$2` token, `$3` lease. One row when the claim was held. The
 * lease is counted from when the row was had: a renewal that waited for it
 * holds for as long as it was asked to, and not for what the wait left.
 */
const RENEW = compact(`
  WITH ${locked('SELECT $1::uuid')}, renewed AS (
    UPDATE workflow_commands
    SET lease_expires_at = ${lease('$3')}
    WHERE id = (SELECT id FROM locked WHERE lease_token = $2 AND ${HELD})
    RETURNING run_id
  )
  SELECT (
    SELECT ${runs.rows} FROM workflow_runs WHERE id = renewed.run_id
  ) AS runs
  FROM renewed`)

/** `$1` run ids. */
const CLAIMED = compact(`
  SELECT DISTINCT run_id FROM workflow_commands
  WHERE run_id = ${uuids('$1')} AND ${HELD}`)

/** Sent out of a transaction that must be rolled back, never to a caller. */
class Abandoned<E> {
  constructor(
    readonly reason:
      | { readonly _tag: 'Need'; readonly scope: ReadScope }
      /** The plan saves definitions it was shown under a shared guard. */
      | { readonly _tag: 'Save'; readonly keys: readonly string[] }
      | { readonly _tag: 'Fail'; readonly error: E },
  ) {}
}

/** Which schedules exist: held by whoever adds or removes one. */
const SCHEDULES = 'schedules'

const runGuard = (id: string) => `run:${id}`
const definitionGuard = (key: string) => `definition:${key}`

/** The runs whose guard a scope takes: a unit is guarded by its run. */
const guardedRuns = (scope: ReadScope) => [
  ...(scope.runs ?? []),
  ...(scope.heads ?? []),
  ...(scope.units ?? []).map(({ runId }) => runId),
  ...(scope.open ?? []).map(({ runId }) => runId),
  ...(scope.childResults ?? []).map(({ runId }) => runId),
  // A family is guarded by its root, as the run it is.
  ...(scope.families ?? []),
]

/** A run an open read reads, and the run of a child of it: `[runId, id]`. */
type Linked = readonly [runId: string, linkedRunId: string]

/** The runs a scope opens, but those no row can be. */
const openedRuns = (scope: ReadScope) =>
  Array.from(opened(scope)).filter(([runId]) => UUID.test(runId))

/** The runs opened as a statement takes them: `[runId, [[name, limit]]]`. */
const openedParam = (open: ReturnType<typeof openedRuns>) =>
  open.map(([runId, maps]) => [
    runId,
    Array.from(maps, ([name, limit]) => [name, limit === 'all' ? null : limit]),
  ])

const guards = (scope: ReadScope) => [
  ...guardedRuns(scope).map(runGuard),
  ...(scope.keys ?? []).map((key) => `key:${key}`),
  ...(scope.definitions ?? []).map(definitionGuard),
  ...(scope.schedules ?? []).map((name) => `schedule:${name}`),
  ...(scope.scheduleNames ? [SCHEDULES] : []),
]

// A deadlock is only possible against locks the adapter does not order: a
// caller's own transaction that holds some already, or other users of the
// tables. The victim's work is undone, so it is done again.
const contended = (error: unknown) =>
  SqlError.isSqlError(error) &&
  (error.reason._tag === 'DeadlockError' ||
    error.reason._tag === 'SerializationError')
const CONTENTION = {
  while: contended,
  times: 5,
  schedule: Schedule.jittered(Schedule.exponential('20 millis')),
}

const storage = <A, R>(effect: Effect.Effect<A, SqlError.SqlError, R>) =>
  Effect.mapError(effect, (cause) => new StorageError({ cause }))

/**
 * The conditions of a list and the values they bind, added as the query
 * names them: a list filters by whatever it was given, in any combination.
 */
function conditions() {
  const where: string[] = []
  const params: unknown[] = []
  const bind = (value: unknown) => `$${params.push(value)}`
  const add = (condition: string) => void where.push(condition)
  return {
    params,
    bind,
    add,
    /** No row has an id that is no uuid, so such an id matches nothing. */
    id: (column: string, id: string) =>
      add(UUID.test(id) ? `${column} = ${bind(id)}::uuid` : 'false'),
    /**
     * After the place a cursor names, in a list ordered by `order`: a time,
     * then a `tie` between equal times. A cursor is that pair of the last
     * item of a page: a place in the order, which holds when the item itself
     * has left the list.
     */
    after: (
      order: string,
      compare: '<' | '>',
      tie: 'uuid' | 'bigint',
      cursor?: string,
    ) => {
      if (cursor === undefined) return
      const [, time, rest] = /^(\d+):(.+)$/.exec(cursor) ?? []
      const placed = tie === 'uuid' ? UUID : /^\d+$/
      // Not a cursor of this list: it names no place, and nothing follows.
      if (time === undefined || !placed.test(rest ?? '')) return add('false')
      add(
        `(${order}) ${compare} (${ofMicros(bind(time))}, ${bind(rest)}::${tie})`,
      )
    },
    sql: () => where.join(' AND ') || 'true',
  }
}

/**
 * A page of rows that were fetched one past the limit: the extra row says
 * there is more, and the place of the last row kept is where the next page
 * begins.
 */
function page<Item, A>(
  rows: readonly { readonly item: Item; readonly place: string }[],
  limit: number,
  decode: (item: Item) => A,
): Page<A> {
  const kept = rows.slice(0, Math.max(0, limit))
  const items = kept.map(({ item }) => decode(item))
  return rows.length > kept.length && kept.length > 0
    ? { items, next: kept.at(-1)!.place }
    : { items }
}

/**
 * The store on PostgreSQL. It depends on `SqlClient` alone, so an engine call
 * made inside a caller's `sql.withTransaction` commits or rolls back with it.
 * Built for `READ COMMITTED`, where a statement after a lock sees what the
 * lock waited for.
 */
export const make = Effect.fnUntraced(function* (
  options: PostgresOptions = {},
) {
  // Name transforms would rewrite the keys of stored JSON.
  const sql = (yield* SqlClient.SqlClient).withoutTransforms()
  const refused = invalid(options)
  if (refused !== undefined) return yield* Effect.die(new Error(refused))
  const { maxDeliveries = 20, channel = CHANNEL, answerTimeoutMs } = options

  /** A statement of the store, with the time the database has to answer it. */
  const ask = <Row extends object>(
    text: string,
    params?: readonly unknown[],
  ): Effect.Effect<readonly Row[], SqlError.SqlError> => {
    const statement = sql.unsafe<Row>(text, params)
    if (answerTimeoutMs === undefined) return statement
    // Interrupted, the statement is cancelled on the server by its driver.
    return Effect.timeoutOrElse(statement, {
      duration: answerTimeoutMs,
      orElse: () => {
        const message = `PostgreSQL did not answer a workflow statement within ${answerTimeoutMs} ms`
        return Effect.fail(
          new SqlError.SqlError({
            reason: new SqlError.StatementTimeoutError({
              cause: new Error(message),
              message,
              operation: 'workflowStatement',
            }),
          }),
        )
      },
    })
  }
  // One latch per subscription, open while a hint waits to be taken, with
  // the payloads that are hints to it.
  const listeners = new Map<Latch.Latch, readonly string[]>()
  const hint = (payload?: string) => {
    for (const [latch, wanted] of listeners) {
      if (payload === undefined || wanted.includes(payload)) latch.openUnsafe()
    }
  }

  const listening = yield* Effect.serviceOption(Notifications)
  if (Option.isSome(listening)) {
    const settled = Latch.makeUnsafe()
    const listen = Effect.scoped(
      Effect.gen(function* () {
        const next = yield* listening.value.listen(channel)
        // What was notified while nothing listened is not known.
        hint()
        settled.openUnsafe()
        for (;;) hint(yield* next)
      }),
    )
    yield* Effect.forkScoped(
      listen.pipe(
        Effect.tapError((error) =>
          Effect.andThen(
            settled.open,
            Effect.logWarning(
              'Workflow hints are not listened for; workers poll',
              error,
            ),
          ),
        ),
        Effect.retry(Schedule.spaced('1 second')),
      ),
    )
    // Either way: a store that cannot listen yet is a store that polls.
    yield* settled.await
  }

  const read = Effect.fnUntraced(function* (
    scope: ReadScope,
    /** Whether a transaction reads, which then holds what it is shown. */
    locking = false,
    /** The runs `LOCK_OPEN` guarded, of the children of runs opened. */
    guarded: readonly Linked[] = [],
    /** Whether the runs of the children of runs opened are read. */
    linking = false,
  ) {
    // An id that is no uuid as the database spells one names no row.
    const uuid = (ids: readonly string[] = []) =>
      ids.filter((id) => UUID.test(id))
    const whole = uuid(scope.runs)
    // A unit of a run no row can have is absent whole, and is not asked.
    const units = (scope.units ?? []).filter(({ runId }) => UUID.test(runId))
    const open = openedRuns(scope)
    const results = (scope.childResults ?? []).filter(({ runId }) =>
      UUID.test(runId),
    )
    const statement = loadOf({
      held: locking,
      units: units.length > 0,
      open: open.length > 0,
      linked: locking && linking && open.length > 0,
      results: results.length > 0,
    })
    const values: Record<LoadParam, () => unknown> = {
      records: () =>
        json([
          ...whole,
          ...uuid(scope.heads),
          ...units.map(({ runId }) => runId),
          ...open.map(([runId]) => runId),
          ...results.map(({ runId }) => runId),
        ]),
      whole: () => json(whole),
      keys: () => json(scope.keys ?? []),
      definitions: () => json(scope.definitions ?? []),
      schedules: () => json(scope.schedules ?? []),
      scheduleNames: () => scope.scheduleNames === true,
      families: () => json(uuid(scope.families)),
      ended: () => ENDED,
      units: () =>
        json(
          units.map(({ runId, nodeName, childKey, attemptId }) => [
            runId,
            nodeName,
            childKey,
            attemptId === undefined ? null : UUID.test(attemptId) && attemptId,
          ]),
        ),
      open: () => json(openedParam(open)),
      results: () =>
        json(results.map(({ runId, nodeName }) => [runId, nodeName])),
      dead: () => json(uuid(scope.dead)),
      guarded: () => json(guarded.map(([, id]) => id)),
    }
    const rows = yield* ask<{ loaded: Loaded }>(
      statement.text,
      statement.params.map((name) => values[name]()),
    )
    const { loaded } = rows[0]!

    const heads = new Map(
      loaded.runs.map((row) => {
        const run = runs.decode(row)
        return [run.id, run] as const
      }),
    )
    const owned = <Stored extends { readonly runId: string }>(
      rows: readonly unknown[][],
      decode: (row: readonly unknown[]) => Stored,
    ) => Map.groupBy(rows.map(decode), ({ runId }) => runId)
    const ownedNodes = owned<StoredNode>(loaded.nodes, nodes.decode)
    const ownedChildren = owned<StoredChild>(loaded.children, children.decode)
    const ownedAttempts = owned<StoredAttempt>(loaded.attempts, attempts.decode)
    const records = (id: string): RunRecords | undefined => {
      const run = heads.get(id)
      return (
        run && {
          run,
          nodes: ownedNodes.get(id) ?? [],
          children: ownedChildren.get(id) ?? [],
          attempts: ownedAttempts.get(id) ?? [],
        }
      )
    }
    const found = new Map(
      units.map((unit, index): [string, UnitRecords] => {
        const [node, child, attempt] = loaded.units[index]!
        return [
          unitKey(unit),
          {
            run: heads.get(unit.runId),
            node: node === null ? undefined : nodes.decode(node),
            child: child === null ? undefined : children.decode(child),
            attempt: attempt === null ? undefined : attempts.decode(attempt),
          },
        ]
      }),
    )
    const shown = new Map(
      loaded.open.map(([runId, read, sets, current]) => {
        const limits = open.find(([id]) => id === runId)![1]
        const childSets = new Map(
          sets.map(([name, rows, mapped]): [string, ChildSet] => {
            const found = rows.map((row) => children.decode(row))
            if (!mapped) return [name, { view: 'all', children: found }]
            const pendingLimit = limits.get(name)!
            const waiting = found.filter(
              ({ status }) => status === STATUSES.pending,
            )
            const pending =
              pendingLimit === 'all' ? waiting : waiting.slice(0, pendingLimit)
            return [
              name,
              {
                view: 'map',
                active: found.filter(
                  ({ status }) => status !== STATUSES.pending,
                ),
                pending,
                pendingLimit,
                hasMore: waiting.length > pending.length,
              },
            ]
          }),
        )
        const records: OpenRecords = {
          run: heads.get(runId)!,
          nodes: read.map(
            ([whole, row]): NodeRead =>
              whole
                ? { view: 'full', record: nodes.decode(row) }
                : {
                    view: 'withoutInput',
                    record: nodesWithoutInput.decode(row),
                  },
          ),
          childSets,
          attempts: current.map((row) => attempts.decode(row)),
          linked: new Map(
            loaded.linked.flatMap(([of, id]) =>
              of === runId ? [[id, heads.get(id)]] : [],
            ),
          ),
        }
        return [runId, records] as const
      }),
    )
    const nodeResults = new Map(
      results.map((read, index): [string, ChildResults] => {
        const [node, rows] = loaded.results[index]!
        return [
          resultsKey(read),
          {
            node: node === null ? undefined : nodes.decode(node),
            children: rows.map((row) => children.decode(row)),
          },
        ]
      }),
    )
    const absent: UnitRecords = {
      run: undefined,
      node: undefined,
      child: undefined,
      attempt: undefined,
    }
    const held = new Map(loaded.keys)
    const saved = new Map(loaded.definitions)
    const scheduled = new Map(
      loaded.schedules.map((row) => {
        const schedule = schedules.decode(row)
        return [schedule.name, schedule] as const
      }),
    )
    const families = new Map(
      loaded.families.map(([row, size, active, activeRunId, claimedRunId]) => {
        const root = summaries.decode(row)
        const family: Family = {
          root,
          size,
          active,
          ...(activeRunId === null ? {} : { activeRunId }),
          ...(claimedRunId === null ? {} : { claimedRunId }),
        }
        return [root.id, family] as const
      }),
    )
    const dead = new Map(loaded.dead.map((row) => [row[0], deadCommand(row)]))
    // An entry for each name as the scope spells it, which is how the plan
    // asks for it again.
    const entries = <A>(
      names: readonly string[] = [],
      of: (name: string) => A,
    ) => new Map(names.map((name) => [name, of(name)]))

    const snapshot: Snapshot = {
      now: loaded.now,
      id: nextId,
      runs: entries(scope.runs, records),
      heads: entries(scope.heads, (id) => heads.get(id)),
      units: new Map(
        (scope.units ?? []).map((unit) => {
          const key = unitKey(unit)
          return [key, found.get(key) ?? absent]
        }),
      ),
      open: new Map(
        Array.from(opened(scope).keys(), (runId) => [runId, shown.get(runId)]),
      ),
      childResults: new Map(
        (scope.childResults ?? []).map((read) => [
          resultsKey(read),
          nodeResults.get(resultsKey(read)) ?? {
            node: undefined,
            children: [],
          },
        ]),
      ),
      keys: entries(scope.keys, (key) => held.get(key)),
      definitions: entries(scope.definitions, (key) => saved.get(key)),
      schedules: entries(scope.schedules, (name) => scheduled.get(name)),
      scheduleNames: loaded.scheduleNames ?? undefined,
      families: entries(scope.families, (id) => families.get(id)),
      dead: entries(scope.dead, (id) => dead.get(id)),
    }
    return snapshot
  })

  const write = Effect.fnUntraced(function* (
    mutation: Mutation,
    scope: ReadScope,
    snapshot: Snapshot,
    /** The ids the transaction gave the plan, which nobody else can know. */
    minted: ReadonlySet<string>,
  ) {
    // What a plan writes it must have read: an unguarded write could
    // overwrite a change the plan never saw.
    const guarded = new Set([
      ...guards(scope),
      ...Array.from(snapshot.open.values()).flatMap((records) =>
        Array.from(records?.linked.keys() ?? [], runGuard),
      ),
    ])
    const check = (name: string) => {
      if (!guarded.has(name)) throw new Error(`Unguarded write to [${name}]`)
    }
    const written = runs.latest(mutation.runs)
    const created = new Set(written.map(({ id }) => id))
    // In another spelling the database would read the id of a run that may
    // be there, and write to what the plan was shown as absent.
    for (const id of created) {
      if (!UUID.test(id)) throw new Error(`Run id [${id}] is not the store's`)
    }
    for (const { key } of mutation.keys ?? []) check(`key:${key}`)
    for (const { key } of mutation.definitions ?? []) {
      check(definitionGuard(key))
    }
    for (const { runId } of [
      ...(mutation.nodes ?? []),
      ...(mutation.nodesPreservingInput ?? []),
      ...(mutation.children ?? []),
      ...(mutation.attempts ?? []),
    ]) {
      if (created.has(runId)) continue
      check(runGuard(runId))
      if (!UUID.test(runId)) throw new Error(`Run [${runId}] does not exist`)
    }
    // Of what a run owns, only what the plan read: a guard is not a view.
    const unread = unloaded(snapshot, mutation, (id) => minted.has(id))
    if (unread !== undefined) throw new Error(`Unguarded write to [${unread}]`)
    const wrong = malformed(mutation)
    if (wrong !== undefined) throw new Error(wrong)
    for (const { name } of mutation.schedules ?? []) {
      check(`schedule:${name}`)
      // Loaded under its guard, so absent then is absent now: it is added.
      if (!snapshot.schedules.get(name)) check(SCHEDULES)
    }
    for (const name of mutation.unschedule ?? []) {
      check(`schedule:${name}`)
      check(SCHEDULES)
    }
    const uuid = (ids: readonly string[] = []) =>
      Array.from(new Set(ids.filter((id) => UUID.test(id))))
    const roots = uuid(scope.families)
    for (const rootRunId of mutation.remove ?? []) {
      if (!scope.families?.includes(rootRunId)) {
        throw new Error(`Unguarded removal of family [${rootRunId}]`)
      }
    }
    const removed = uuid(mutation.remove)

    const claims = (claimed: readonly Claim[] = []) =>
      new Map(claimed.map((claim) => [claim.id, claim]))
    const acks = claims(mutation.ack)
    const holds = claims(mutation.hold)
    const stale = (
      claimed: ReadonlyMap<string, Claim>,
      ids: readonly string[],
    ) => {
      const lost = Array.from(claimed).find(([id]) => !ids.includes(id))
      return lost === undefined
        ? Effect.void
        : Effect.fail(new StaleClaim({ commandId: lost[1].id }))
    }
    // The id of a command is a uuid: no other was ever claimed.
    const real = (claimed: ReadonlyMap<string, Claim>) =>
      Array.from(claimed.keys()).filter((id) => UUID.test(id))
    yield* stale(acks, real(acks))
    yield* stale(holds, real(holds))

    // Changes apply in order, so the last one says what a key ends as.
    const keys = new Map(
      (mutation.keys ?? []).map((change) => [change.key, change]),
    )
    const ended = (op: 'acquire' | 'release') =>
      Array.from(keys.values()).filter((change) => change.op === op)
    const definitions = new Map(
      (mutation.definitions ?? []).map((record) => [record.key, record]),
    )
    // Of the commands with one key, the first is the one that may be added,
    // and it or the one that waits is due when the earliest of them is.
    const wanted = new Map<string, Enqueue>()
    for (const entry of mutation.enqueue ?? []) {
      const first = wanted.get(entry.dedupe)
      const at = (queued: Enqueue) => queued.availableAt ?? snapshot.now
      wanted.set(
        entry.dedupe,
        first === undefined
          ? entry
          : { ...first, availableAt: Math.min(at(first), at(entry)) },
      )
    }
    const topics = (mutation.notify ?? [])
      .filter((topic) => topic.length <= MAX_TOPIC)
      .map((topic) => `${TOPIC}${topic}`)

    // A run written without having been loaded is one the plan creates, and
    // whoever loaded its id as absent holds its guard. It is taken now, so
    // that the insert waits for them and is judged on what they left. An id
    // this transaction made is known to nobody else, and needs none.
    const fresh = written
      .filter(({ id }) => !minted.has(id))
      .map(({ id }) => runGuard(id))
      .filter((name) => !guarded.has(name))
    if (fresh.length > 0) yield* ask(LOCK, [json(fresh), json([])])

    const writes = Object.values(mutation).some((part) => part.length > 0)
    // A plan that writes nothing only read the families, at one moment.
    if (roots.length > 0 && writes) {
      yield* ask(HOLD_ROOTS, [json(roots)])
      yield* ask(HOLD_MEMBERS, [json(roots)])
      const counted = yield* ask<{
        root: string
        size: number
        active: number
      }>(COUNT, [json(roots), ENDED])
      const changed = roots.some((rootRunId) => {
        const family = snapshot.families.get(rootRunId)
        const found = counted.find(({ root }) => root === rootRunId)
        return (
          (family?.size ?? 0) !== (found?.size ?? 0) ||
          (family?.active ?? 0) !== (found?.active ?? 0)
        )
      })
      // No longer what the plan was shown: planned again, on what it is.
      if (changed) {
        return yield* Effect.fail(
          new Abandoned<never>({ _tag: 'Need', scope: {} }),
        )
      }
    }

    const preserved = nodesWithoutInput.latest(mutation.nodesPreservingInput)
    const pairs = (claimed: ReadonlyMap<string, Claim>) =>
      json(Array.from(claimed.values(), ({ id, token }) => ({ id, token })))
    const found =
      written.length > 0 ? uuid(Array.from(foundRuns(snapshot))) : []
    const statement = commitOf({
      claims: acks.size > 0 || holds.size > 0,
      runs: written.length > 0,
      nodes: (mutation.nodes?.length ?? 0) > 0,
      kept: preserved.length > 0,
      attempts: (mutation.attempts?.length ?? 0) > 0,
      children: (mutation.children?.length ?? 0) > 0,
      released: ended('release').length > 0,
      acquired: ended('acquire').length > 0,
      definitions: definitions.size > 0,
      schedules: (mutation.schedules?.length ?? 0) > 0,
      unschedule: (mutation.unschedule?.length ?? 0) > 0,
      removed: removed.length > 0,
      enqueue: wanted.size > 0,
      topics: topics.length > 0,
    })
    const values: Record<CommitParam, () => unknown> = {
      acks: () => pairs(acks),
      holds: () => pairs(holds),
      runs: () => json(written),
      // Written over only where the plan read the record: a guard is not a
      // view, and a family's root is guarded without being read.
      found: () => json(found),
      nodes: () => json(nodes.latest(mutation.nodes)),
      kept: () => json(preserved),
      attempts: () => json(attempts.latest(mutation.attempts)),
      children: () => json(children.latest(mutation.children)),
      released: () => json(ended('release').map(({ key }) => key)),
      acquired: () => json(ended('acquire')),
      definitions: () => json(Array.from(definitions.values())),
      schedules: () => json(schedules.latest(mutation.schedules)),
      unschedule: () => json(mutation.unschedule ?? []),
      removed: () => json(removed),
      enqueue: () => json(Array.from(wanted.values())),
      now: () => snapshot.now,
      channel: () => channel,
      topics: () => json(topics),
    }
    const rows = yield* ask<{
      acked: readonly string[]
      held: readonly string[]
      runs: readonly string[]
      saved: readonly string[]
      kept: number
    }>(
      statement.text,
      statement.params.map((name) => values[name]()),
    )
    const result = rows[0]!

    yield* stale(acks, result.acked)
    yield* stale(holds, result.held)
    for (const { id } of written) {
      if (result.runs.includes(id)) continue
      // It exists, and the statement writes only over what was loaded.
      check(runGuard(id))
      throw new Error(`Run [${id}] was not written`)
    }
    // Each was read, under the guard of its run: it is there.
    if (result.kept !== preserved.length) {
      throw new Error('A node written but for its input does not exist')
    }
    for (const key of definitions.keys()) {
      // Guarded, so the plan saw this record and chose to write over it.
      if (!result.saved.includes(key)) {
        throw new Error(`Definition [${key}] is already saved`)
      }
    }
  })

  const transact = <A, E = never>(
    initial: ReadScope,
    plan: Plan<A, E>,
  ): Effect.Effect<A, E | StaleClaim | StorageError> => {
    // Inside a caller's transaction this one is a savepoint: what it locks
    // and writes is undone with it, and kept until the caller commits.
    //
    // A definition is saved once and never changed, so it is guarded alone
    // only by a commit that saves it, and shared by those that read it: they
    // shut out its first saving, and never one another. Every start and
    // pass of a definition reads it, and would otherwise wait for any
    // transaction that has started a run of it and not yet committed.
    const attempt = (scope: ReadScope, saving: ReadonlySet<string>) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const names = guards(scope)
          // Of a run opened without the runs of its children, they are
          // neither guarded nor read.
          const links = linking(scope)
          const open = openedRuns(scope).filter(([runId]) => links.has(runId))
          let linked: readonly Linked[] = []
          if (names.length > 0) {
            const shared = (scope.definitions ?? [])
              .filter((key) => !saving.has(key))
              .map(definitionGuard)
            const alone = json(names.filter((name) => !shared.includes(name)))
            if (open.length > 0) {
              const [taken] = yield* ask<{ linked: readonly Linked[] }>(
                LOCK_OPEN,
                [alone, json(shared), json(openedParam(open)), ENDED],
              )
              linked = taken!.linked
            } else yield* ask(LOCK, [alone, json(shared)])
          }
          const minted = new Set<string>()
          // Read after the locks: `now` is the time the plan's view is of.
          const snapshot: Snapshot = {
            ...(yield* read(scope, true, linked, open.length > 0)),
            id: () => {
              const id = nextId()
              minted.add(id)
              return id
            },
          }
          const planned = plan(snapshot)
          if (planned._tag !== 'Commit') {
            return yield* Effect.fail(
              new Abandoned<E | StaleClaim>(
                planned._tag === 'Need'
                  ? planned
                  : { _tag: 'Fail', error: planned.error },
              ),
            )
          }
          // One the scope did not name is refused by `write` as unguarded.
          const unsaved = (planned.mutation.definitions ?? [])
            .map(({ key }) => key)
            .filter(
              (key) => scope.definitions?.includes(key) && !saving.has(key),
            )
          if (unsaved.length > 0) {
            return yield* Effect.fail(
              new Abandoned<E | StaleClaim>({ _tag: 'Save', keys: unsaved }),
            )
          }
          if (options.beforeCommit) {
            yield* options.beforeCommit(planned.mutation)
          }
          yield* write(planned.mutation, scope, snapshot, minted).pipe(
            Effect.mapError((error) =>
              error instanceof StaleClaim
                ? new Abandoned<E | StaleClaim>({ _tag: 'Fail', error })
                : error,
            ),
          )
          return planned.result
        }),
      )

    const run = (
      scope: ReadScope,
      saving: ReadonlySet<string> = new Set(),
    ): Effect.Effect<A, E | StaleClaim | StorageError> =>
      Effect.catch(
        Effect.retry(attempt(scope, saving), CONTENTION),
        (error) => {
          if (!(error instanceof Abandoned)) {
            return Effect.fail(new StorageError({ cause: error }))
          }
          // More is locked only from the start, in order: locks taken while
          // others are held are how transactions come to wait on each other.
          // The same holds of a guard taken alone that was shared before.
          switch (error.reason._tag) {
            case 'Need':
              return run(widened(scope, error.reason.scope), saving)
            case 'Save':
              return run(scope, new Set([...saving, ...error.reason.keys]))
            case 'Fail':
              return Effect.fail(error.reason.error)
          }
        },
      )

    return run(initial)
  }

  const claim = <K extends Command['kind']>(request: ClaimOptions<K>) =>
    storage(
      ask<Claim<Extract<Command, { kind: K }>>>(CLAIM, [
        json(request.lanes),
        request.limit,
        request.leaseMs,
        maxDeliveries,
      ]),
    )

  const held = <A>(
    { id }: Claim,
    statement: Effect.Effect<Option.Option<A>, SqlError.SqlError>,
  ) =>
    Effect.flatMap(
      UUID.test(id) ? storage(statement) : Effect.succeedNone,
      Option.match({
        onNone: () => Effect.fail(new StaleClaim({ commandId: id })),
        onSome: (value: A) => Effect.succeed(value),
      }),
    )

  const release = (
    released: Claim,
    { error, delayMs = 0 }: ReleaseOptions = {},
  ) =>
    held(
      released,
      Effect.map(
        ask<{ released: number }>(RELEASE, [
          released.id,
          released.token,
          delayMs,
          error === undefined ? null : json(storedError(error)),
          channel,
        ]),
        ([row]) => (row!.released > 0 ? Option.some(undefined) : Option.none()),
      ),
    )

  const renew = (renewed: Claim, leaseMs: number) =>
    held(
      renewed,
      Effect.map(
        ask<{ runs: readonly unknown[][] }>(RENEW, [
          renewed.id,
          renewed.token,
          leaseMs,
        ]),
        ([row]): Option.Option<StoredRun | undefined> =>
          row
            ? Option.some(row.runs[0] && runs.decode(row.runs[0]))
            : Option.none(),
      ),
    )

  /** Subscribes to payloads; the effect it gives takes the next hint. */
  const subscribed = (payloads: readonly string[]) =>
    Effect.map(
      Effect.acquireRelease(
        Effect.sync(() => {
          const latch = Latch.makeUnsafe()
          listeners.set(latch, payloads)
          return latch
        }),
        (latch) => Effect.sync(() => listeners.delete(latch)),
      ),
      (latch) =>
        Effect.andThen(
          latch.await,
          Effect.sync(() => {
            latch.closeUnsafe()
          }),
        ),
    )

  const hints = (kinds: readonly Command['kind'][]) =>
    subscribed(kinds.map((kind) => `${KIND}${kind}`))

  const listen = (topic: string) => subscribed([`${TOPIC}${topic}`])

  const load = (runId: string) =>
    storage(
      Effect.map(read({ runs: [runId] }), (snapshot) =>
        snapshot.runs.get(runId),
      ),
    )

  const listed = (query: {
    readonly filter?: RunFilter
    readonly limit: number
    readonly after?: string
  }) => {
    const { add, after, bind, id, params, sql: where } = conditions()
    const { filter = {}, limit } = query
    const { revision, parentRunId, status, tags, input } = filter
    if (filter.kind !== undefined) add(`kind::text = ${bind(filter.kind)}`)
    if (filter.name !== undefined) add(`name = ${bind(filter.name)}`)
    if (revision === null) add('execution_revision IS NULL')
    else if (revision !== undefined) {
      add(`execution_revision = ${bind(revision)}`)
    }
    if (status !== undefined) add(`status::text = ${texts(bind(json(status)))}`)
    if (filter.activeBefore !== undefined) {
      add(`active_since < ${instant(bind(filter.activeBefore))}`)
    }
    if (filter.createdBefore !== undefined) {
      add(`created_at < ${instant(bind(filter.createdBefore))}`)
    }
    if (parentRunId === null) add('parent_run_id IS NULL')
    else if (parentRunId !== undefined) id('parent_run_id', parentRunId)
    if (filter.rootRunId !== undefined) id('root_run_id', filter.rootRunId)
    if (tags !== undefined) add(`tags @> ${bind(json(tags))}::jsonb`)
    if (input !== undefined) add(`input @> ${bind(json(input))}::jsonb`)
    // Newest first, so the next page is what sorts before its last run.
    after('created_at, id', '<', 'uuid', query.after)

    return storage(
      Effect.map(
        ask<{
          item: readonly [
            run: readonly unknown[],
            nodesTotal: number,
            nodesCompleted: number,
            origin: readonly [nodeName: string, childKey: string] | null,
          ]
          place: string
        }>(
          `SELECT jsonb_build_array(
            ${summaries.row},
            (SELECT count(*) FROM workflow_nodes WHERE run_id = run.id),
            -- How far its nodes are: the one status a list is asked to count.
            (SELECT count(*) FROM workflow_nodes
             WHERE run_id = run.id AND status::text = ${bind(STATUSES.completed)}),
            (SELECT jsonb_build_array(node_name, child_key)
             FROM workflow_node_children WHERE child_run_id = run.id LIMIT 1)
          ) AS item, ${micros('created_at')} || ':' || id AS place
          FROM (
            SELECT * FROM workflow_runs
            WHERE ${where()}
            ORDER BY created_at DESC, id DESC
            LIMIT ${bind(Math.max(0, limit) + 1)}
          ) AS run
          ORDER BY created_at DESC, id DESC`,
          params,
        ),
        (rows) =>
          page(rows, limit, (item): ListedRun => {
            const [run, nodesTotal, nodesCompleted, origin] = item
            const summary: RunSummary = summaries.decode(run)
            return {
              ...summary,
              nodesTotal,
              nodesCompleted,
              ...(origin === null
                ? {}
                : { origin: { nodeName: origin[0], childKey: origin[1] } }),
            }
          }),
      ),
    )
  }

  const dead = (query: {
    readonly id?: string
    readonly runId?: string
    readonly active?: true
    readonly limit: number
    readonly after?: string
  }) => {
    const { add, after, bind, id, params, sql: where } = conditions()
    add('dead_at IS NOT NULL')
    if (query.id !== undefined) id('id', query.id)
    if (query.runId !== undefined) id('run_id', query.runId)
    if (query.active) {
      add(`NOT EXISTS (
        SELECT FROM workflow_runs
        WHERE id = command.run_id AND ${finished(bind(ENDED))}
      )`)
    }
    // Set aside in this order: those of one claim, as they were queued.
    after('dead_at, seq', '>', 'bigint', query.after)

    return storage(
      Effect.map(
        ask<{ item: DeadRow; place: string }>(
          `SELECT ${DEAD} AS item, ${micros('dead_at')} || ':' || seq AS place
          FROM workflow_commands AS command
          WHERE ${where()}
          ORDER BY dead_at, seq
          LIMIT ${bind(Math.max(0, query.limit) + 1)}`,
          params,
        ),
        (rows) => page(rows, query.limit, deadCommand),
      ),
    )
  }

  const claimed = (runIds: readonly string[]) =>
    storage(
      Effect.map(
        ask<{ run_id: string }>(CLAIMED, [
          json(runIds.filter((id) => UUID.test(id))),
        ]),
        (rows) => {
          const under = new Set(rows.map(({ run_id }) => run_id))
          return runIds.filter((id) => under.has(id))
        },
      ),
    )

  const scheduled = (query: {
    readonly due?: Timestamp
    readonly limit: number
    readonly after?: string
  }) => {
    const { add, bind, params, sql: where } = conditions()
    const { due, limit } = query
    if (due !== undefined) {
      add(`enabled AND next_run_at <= ${instant(bind(due))}`)
    }
    // By code point, whatever the collation of the database.
    if (query.after !== undefined) {
      add(`name COLLATE "C" > ${bind(query.after)}`)
    }

    return storage(
      Effect.map(
        ask<{ item: readonly unknown[]; place: string }>(
          `SELECT ${schedules.row} AS item, name AS place
          FROM workflow_schedules
          WHERE ${where()}
          ORDER BY name COLLATE "C"
          LIMIT ${bind(Math.max(0, limit) + 1)}`,
          params,
        ),
        (rows) => page(rows, limit, schedules.decode),
      ),
    )
  }

  const prunable = (query: {
    readonly status: RunStatus
    readonly updatedBefore: Timestamp
    readonly limit: number
    readonly after?: string
  }) => {
    const { add, after, bind, params, sql: where } = conditions()
    // As `workflow_runs_prune_idx` has them: roots, by status, then by time.
    add('parent_run_id IS NULL')
    add(`status = ${bind(query.status)}::workflow_run_status`)
    add(`updated_at < ${instant(bind(query.updatedBefore))}`)
    after('updated_at, id', '>', 'uuid', query.after)

    return storage(
      Effect.map(
        ask<{ item: string; place: string }>(
          `SELECT id AS item, ${micros('updated_at')} || ':' || id AS place
          FROM workflow_runs
          WHERE ${where()}
          ORDER BY updated_at, id
          LIMIT ${bind(Math.max(0, query.limit) + 1)}`,
          params,
        ),
        (rows) => page(rows, query.limit, (id) => id),
      ),
    )
  }

  return Store.of({
    transact,
    claim,
    release,
    renew,
    hints,
    listen,
    load,
    runs: listed,
    dead,
    claimed,
    schedules: scheduled,
    prunable,
  })
})

/**
 * Hints need `Notifications`, taken when the layer is built if it is there:
 * `Layer.provide` it for hints, or leave it out and workers poll.
 */
export const layer = (
  options?: PostgresOptions,
): Layer.Layer<Store, never, SqlClient.SqlClient> =>
  Layer.effect(Store, make(options))
