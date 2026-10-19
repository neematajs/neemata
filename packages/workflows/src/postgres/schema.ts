import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

import { STATUSES } from '../model.ts'
import { idempotencyKey, uniqueKey } from '../plan/keys.ts'
import { ACTIVE, PENDING } from './records.ts'

/**
 * The schema generation this adapter reads and writes. Generations 1 to 4
 * are those of the Promise engine (`@nmtjs/workflows` up to 0.18.0-alpha.4,
 * which installs 4); 6 is reached from 4 by `MIGRATION_FROM_4`, and 7 from 6
 * by `MIGRATION_FROM_6`. No release installed a generation 5.
 */
export const SCHEMA_VERSION = 7

const TERMINAL = STATUSES.terminal.map((status) => `'${status}'`).join(', ')

const LANE_INDEX = `CREATE INDEX workflow_commands_lane_idx
  ON workflow_commands (kind, name, revision, seq, run_at)
  WHERE dead_at IS NULL`

/**
 * A node's children by ordinal: those waiting, those under way, and all of
 * them. A pass reads the first of a map's waiting children and all those
 * under way, and a map that is done reads all of them once, in order.
 */
const CHILD_INDEXES = [
  `CREATE INDEX workflow_children_pending_ordinal_idx
    ON workflow_node_children (run_id, node_name, ordinal, child_key)
    WHERE ${PENDING}`,
  `CREATE INDEX workflow_children_active_ordinal_idx
    ON workflow_node_children (run_id, node_name, ordinal, child_key)
    WHERE ${ACTIVE}`,
  `CREATE INDEX workflow_children_ordinal_idx
    ON workflow_node_children (run_id, node_name, ordinal, child_key)`,
]

/**
 * Generation 7 on a database that has no workflow tables. For tests and
 * local development: applications own their production migrations. Table
 * names are unqualified, so `search_path` chooses the schema.
 */
export const INSTALL: readonly string[] = [
  `CREATE TABLE workflow_schema_version (
    id integer PRIMARY KEY DEFAULT 1,
    version integer NOT NULL,
    installed_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT workflow_schema_version_singleton_chk CHECK (id = 1)
  )`,
  `INSERT INTO workflow_schema_version (id, version) VALUES (1, ${SCHEMA_VERSION})`,
  `CREATE TYPE workflow_run_kind AS ENUM ('workflow', 'task')`,
  `CREATE TYPE workflow_node_kind AS ENUM (
    'activity', 'task', 'workflow', 'branch', 'parallel', 'mapTask', 'mapWorkflow',
    'sleep', 'now', 'input'
  )`,
  `CREATE TYPE workflow_node_child_kind AS ENUM ('activity', 'task', 'workflow')`,
  `CREATE TYPE workflow_run_status AS ENUM (
    'queued', 'running', 'waiting', 'cancelling', 'cancelled', 'failed', 'completed'
  )`,
  `CREATE TYPE workflow_node_status AS ENUM (
    'pending', 'running', 'waiting', 'cancelling', 'cancelled', 'failed', 'completed'
  )`,
  `CREATE TYPE workflow_attempt_status AS ENUM (
    'started', 'completed', 'failed', 'timedOut', 'cancelled'
  )`,
  // Shared by every run that names them, and never deleted with one.
  `CREATE TABLE workflow_definitions (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE workflow_runs (
    id uuid PRIMARY KEY,
    kind workflow_run_kind NOT NULL,
    name text NOT NULL,
    status workflow_run_status NOT NULL,
    input jsonb,
    output jsonb,
    error jsonb,
    parent_run_id uuid,
    parent_node_name text,
    parent_route_name text,
    parent_route_revision text,
    root_run_id uuid NOT NULL,
    tags jsonb NOT NULL DEFAULT '{}'::jsonb,
    idempotency_key jsonb,
    unique_key jsonb,
    unique_scope text,
    unique_behavior text,
    execution_revision text,
    graph_hash text,
    graph_presentation jsonb,
    version integer NOT NULL,
    active_since timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CONSTRAINT workflow_runs_parent_run_fk FOREIGN KEY (parent_run_id)
      REFERENCES workflow_runs (id) ON DELETE CASCADE,
    CONSTRAINT workflow_runs_root_run_fk FOREIGN KEY (root_run_id)
      REFERENCES workflow_runs (id) ON DELETE CASCADE
  )`,
  `CREATE INDEX workflow_runs_parent_idx ON workflow_runs (parent_run_id)
    WHERE parent_run_id IS NOT NULL`,
  `CREATE INDEX workflow_runs_root_idx ON workflow_runs (root_run_id)`,
  `CREATE INDEX workflow_runs_prune_idx ON workflow_runs (status, updated_at)
    WHERE parent_run_id IS NULL`,
  // Lists are newest first, a page at a time.
  `CREATE INDEX workflow_runs_created_idx ON workflow_runs (created_at, id)`,
  `CREATE TABLE workflow_nodes (
    run_id uuid NOT NULL,
    name text NOT NULL,
    kind workflow_node_kind NOT NULL,
    status workflow_node_status NOT NULL,
    input jsonb,
    output jsonb,
    error jsonb,
    selected_case text,
    operation jsonb,
    version integer NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (run_id, name),
    CONSTRAINT workflow_nodes_run_fk FOREIGN KEY (run_id)
      REFERENCES workflow_runs (id) ON DELETE CASCADE
  )`,
  `ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_parent_node_fk
    FOREIGN KEY (parent_run_id, parent_node_name)
    REFERENCES workflow_nodes (run_id, name) ON DELETE CASCADE`,
  `CREATE TABLE workflow_attempts (
    id uuid PRIMARY KEY,
    run_id uuid NOT NULL,
    node_name text NOT NULL,
    child_key text NOT NULL,
    status workflow_attempt_status NOT NULL,
    attempt_number integer NOT NULL,
    retry_attempt_number integer NOT NULL,
    input jsonb,
    output jsonb,
    error jsonb,
    dispatched_at timestamptz NOT NULL,
    completed_at timestamptz,
    CONSTRAINT workflow_attempts_child_attempt_key
      UNIQUE (run_id, node_name, child_key, attempt_number),
    CONSTRAINT workflow_attempts_node_fk FOREIGN KEY (run_id, node_name)
      REFERENCES workflow_nodes (run_id, name) ON DELETE CASCADE
  )`,
  `CREATE INDEX workflow_attempts_node_idx ON workflow_attempts (run_id, node_name)`,
  `CREATE TABLE workflow_node_children (
    run_id uuid NOT NULL,
    node_name text NOT NULL,
    child_key text NOT NULL,
    kind workflow_node_child_kind NOT NULL,
    status workflow_node_status NOT NULL,
    ordinal integer,
    item jsonb,
    input jsonb,
    output jsonb,
    error jsonb,
    child_run_id uuid,
    cancellation text,
    current_attempt_id uuid,
    attempt_count integer NOT NULL DEFAULT 0,
    version integer NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (run_id, node_name, child_key),
    CONSTRAINT workflow_node_children_run_fk FOREIGN KEY (run_id)
      REFERENCES workflow_runs (id) ON DELETE CASCADE,
    CONSTRAINT workflow_node_children_node_fk FOREIGN KEY (run_id, node_name)
      REFERENCES workflow_nodes (run_id, name) ON DELETE CASCADE,
    CONSTRAINT workflow_node_children_child_run_fk FOREIGN KEY (child_run_id)
      REFERENCES workflow_runs (id) ON DELETE SET NULL,
    CONSTRAINT workflow_node_children_current_attempt_fk
      FOREIGN KEY (current_attempt_id)
      REFERENCES workflow_attempts (id) ON DELETE SET NULL
  )`,
  `CREATE INDEX workflow_node_children_node_idx
    ON workflow_node_children (run_id, node_name)`,
  `CREATE INDEX workflow_node_children_child_run_idx
    ON workflow_node_children (child_run_id)`,
  ...CHILD_INDEXES,
  // Identity keys: which run holds each. What a key means, and when a run
  // lets go of one, is the plans' to say.
  `CREATE TABLE workflow_keys (
    key text PRIMARY KEY,
    run_id uuid NOT NULL,
    CONSTRAINT workflow_keys_run_fk FOREIGN KEY (run_id)
      REFERENCES workflow_runs (id) ON DELETE CASCADE
  )`,
  `CREATE INDEX workflow_keys_run_idx ON workflow_keys (run_id)`,
  // kind, run_id, name and revision repeat what the payload says: claims
  // route on them, and the run takes its commands with it when deleted.
  `CREATE TABLE workflow_commands (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL,
    run_id uuid NOT NULL,
    revision text,
    payload jsonb NOT NULL,
    run_at timestamptz NOT NULL,
    -- Set by the first claim and kept; the expiry is set while a claim is out.
    lease_token text,
    lease_expires_at timestamptz,
    delivery_count integer NOT NULL DEFAULT 0,
    last_error jsonb,
    dead_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    name text NOT NULL,
    dedupe text NOT NULL,
    seq bigint GENERATED ALWAYS AS IDENTITY,
    CONSTRAINT workflow_commands_run_fk FOREIGN KEY (run_id)
      REFERENCES workflow_runs (id) ON DELETE CASCADE
  )`,
  // A lane's commands in the order they were queued, which is the order a
  // claim takes them in: it reads the head of each lane it serves. `run_at`
  // lets it pass over those not yet due without reading their rows.
  LANE_INDEX,
  // A command with no lease token was never claimed: one per dedupe key,
  // whoever queues it. One given back keeps its token and has no expiry;
  // several of those may wait, and are found here.
  `CREATE UNIQUE INDEX workflow_commands_fresh_idx ON workflow_commands (dedupe)
    WHERE lease_token IS NULL AND dead_at IS NULL`,
  `CREATE INDEX workflow_commands_released_idx ON workflow_commands (dedupe)
    WHERE lease_token IS NOT NULL AND lease_expires_at IS NULL
      AND dead_at IS NULL`,
  `CREATE INDEX workflow_commands_dead_idx ON workflow_commands (dead_at)
    WHERE dead_at IS NOT NULL`,
  `CREATE INDEX workflow_commands_run_idx ON workflow_commands (run_id)`,
  // What a schedule means, its cadence included, is the plans' to say.
  `CREATE TABLE workflow_schedules (
    name text PRIMARY KEY,
    runnable_kind workflow_run_kind NOT NULL,
    runnable_name text NOT NULL,
    execution_revision text,
    graph_hash text,
    graph_presentation jsonb,
    input jsonb,
    tags jsonb NOT NULL DEFAULT '{}'::jsonb,
    cron text,
    every_ms bigint,
    enabled boolean NOT NULL,
    next_run_at timestamptz NOT NULL,
    last_slot_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    time_zone text,
    version integer NOT NULL
  )`,
  // The schedules a scheduler finds due.
  `CREATE INDEX workflow_schedules_due_idx ON workflow_schedules (next_run_at)
    WHERE enabled`,
]

/** Generation 4 to 6, up to where identity keys are carried over. */
const BEFORE_KEYS: readonly string[] = [
  `SET LOCAL lock_timeout = '5s'`,
  // Held to the end, so what is checked next stays true: a process of the
  // old engine that is still running waits here, then fails on the new schema.
  `LOCK TABLE workflow_runs, workflow_commands IN ACCESS EXCLUSIVE MODE`,
  `DO $$
  DECLARE
    installed integer;
  BEGIN
    SELECT version INTO installed FROM workflow_schema_version WHERE id = 1;
    IF installed IS DISTINCT FROM 4 THEN
      RAISE EXCEPTION
        'workflow schema generation is %, this upgrade applies to generation 4 only',
        COALESCE(installed::text, 'missing');
    END IF;
    -- Runs in flight and their commands are records of the old engine, which
    -- the new one cannot continue: the old engine finishes them first.
    IF EXISTS (SELECT FROM workflow_runs WHERE status NOT IN (${TERMINAL})) THEN
      RAISE EXCEPTION 'workflow runs are still in flight: drain the old engine first';
    END IF;
    IF EXISTS (SELECT FROM workflow_commands WHERE dead_at IS NULL) THEN
      RAISE EXCEPTION 'workflow commands are still queued: drain the old engine first';
    END IF;
  END
  $$`,

  // Definitions: one table of records by key, which the engine saves and
  // compares without reading them. Generation 4 saved none: every run it
  // made is unversioned, and stays so.
  `CREATE TABLE workflow_definitions (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  // Schedules: kept, each at the slot it was at, so that none is fired
  // again for a slot the old engine fired. They are records by name now,
  // whose rules are the plans'. Unversioned, as they were: what a schedule
  // pins is saved by a reconcile.
  `ALTER TABLE workflow_schedules
    DROP CONSTRAINT workflow_schedules_cadence_chk,
    DROP CONSTRAINT workflow_schedules_name_key,
    DROP COLUMN id,
    ADD PRIMARY KEY (name),
    ADD COLUMN execution_revision text,
    ADD COLUMN graph_hash text,
    ADD COLUMN graph_presentation jsonb,
    ADD COLUMN time_zone text,
    ADD COLUMN version integer NOT NULL DEFAULT 1,
    ALTER COLUMN input DROP NOT NULL,
    ALTER COLUMN created_at DROP DEFAULT,
    ALTER COLUMN updated_at DROP DEFAULT`,
  `ALTER TABLE workflow_schedules ALTER COLUMN version DROP DEFAULT`,
  `DROP INDEX workflow_schedules_due_idx`,
  `CREATE INDEX workflow_schedules_due_idx ON workflow_schedules (next_run_at)
    WHERE enabled`,

  // Identity keys: a table of their own, where the status rules that the
  // partial unique indexes on runs encoded are now the plans'. Every run is
  // terminal here, so the keys still held are the ones that outlive a run.
  `CREATE TABLE workflow_keys (
    key text PRIMARY KEY,
    run_id uuid NOT NULL,
    CONSTRAINT workflow_keys_run_fk FOREIGN KEY (run_id)
      REFERENCES workflow_runs (id) ON DELETE CASCADE
  )`,
]

/**
 * The identity keys of stored runs, written by the database. A key is the
 * text the engine's `canonical()` gives, which SQL can write for all values
 * but two kinds; a run whose key holds one of those is named and the
 * migration refused, where it would be carried over under a text no start
 * finds again. `migrateFrom4` writes the keys in the process, for all values.
 */
const KEYS_IN_SQL: readonly string[] = [
  `CREATE FUNCTION pg_temp.workflow_canonical(value jsonb) RETURNS text
  LANGUAGE plpgsql IMMUTABLE AS $$
  BEGIN
    -- JSON as the engine's canonical() writes it: no whitespace, and object
    -- keys in JavaScript's order, array indices first.
    RETURN CASE jsonb_typeof(value)
      WHEN 'object' THEN (
        SELECT '{' || coalesce(string_agg(
          to_jsonb(key)::text || ':' || pg_temp.workflow_canonical(item), ','
          ORDER BY
            CASE WHEN key ~ '^(0|[1-9][0-9]{0,9})$' THEN
              CASE WHEN key::numeric < 4294967295 THEN key::numeric END
            END NULLS LAST,
            key COLLATE "C"
        ), '') || '}'
        FROM jsonb_each(value) AS field(key, item)
      )
      WHEN 'array' THEN (
        SELECT '[' || coalesce(string_agg(
          pg_temp.workflow_canonical(item), ',' ORDER BY position
        ), '') || ']'
        FROM jsonb_array_elements(value) WITH ORDINALITY AS element(item, position)
      )
      ELSE value::text
    END;
  END
  $$`,
  `CREATE FUNCTION pg_temp.workflow_inexact(value jsonb) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE AS $$
  BEGIN
    -- What workflow_canonical() writes otherwise than JavaScript: a number
    -- JavaScript prints with an exponent, and the order of object keys once
    -- one is beyond the BMP, where UTF-16 units and code points disagree.
    RETURN CASE jsonb_typeof(value)
      WHEN 'number' THEN abs(value::text::numeric) >= 1e21
        OR (value::text::numeric <> 0 AND abs(value::text::numeric) < 0.000001)
      WHEN 'object' THEN EXISTS (
        SELECT FROM jsonb_each(value) AS field(key, item)
        WHERE key ~ '[\\U00010000-\\U0010FFFF]' OR pg_temp.workflow_inexact(item)
      )
      WHEN 'array' THEN EXISTS (
        SELECT FROM jsonb_array_elements(value) AS item
        WHERE pg_temp.workflow_inexact(item)
      )
      ELSE false
    END;
  END
  $$`,
  `DO $$
  DECLARE
    inexact text;
  BEGIN
    SELECT string_agg(id::text, ', ') INTO inexact
    FROM (
      SELECT id FROM workflow_runs
      WHERE pg_temp.workflow_inexact(idempotency_key)
        OR (unique_scope = 'all' AND pg_temp.workflow_inexact(unique_key))
      ORDER BY id
      LIMIT 20
    ) AS found;
    IF inexact IS NOT NULL THEN
      RAISE EXCEPTION
        'this script cannot write the identity keys of workflow runs % as the engine does: migrate with migrateFrom4 instead',
        inexact;
    END IF;
  END
  $$`,
  `INSERT INTO workflow_keys (key, run_id)
  SELECT 'idempotency:' || pg_temp.workflow_canonical(idempotency_key), id
  FROM workflow_runs
  WHERE idempotency_key IS NOT NULL`,
  `INSERT INTO workflow_keys (key, run_id)
  SELECT 'unique:all:' || pg_temp.workflow_canonical(unique_key), id
  FROM workflow_runs
  WHERE unique_key IS NOT NULL AND unique_scope = 'all'`,
  `DROP FUNCTION pg_temp.workflow_canonical(jsonb)`,
  `DROP FUNCTION pg_temp.workflow_inexact(jsonb)`,
]

/** The rest of the migration, once the keys are written. */
const AFTER_KEYS: readonly string[] = [
  `CREATE INDEX workflow_keys_run_idx ON workflow_keys (run_id)`,
  `DROP INDEX workflow_runs_idempotency_idx,
    workflow_runs_unique_active_idx, workflow_runs_unique_all_idx`,

  // Records: columns the new records have no field for go, and a column a
  // record may leave unset may be NULL. Nodes, children and attempts change
  // in the catalog only; of runs, those under a parent are rewritten once.
  // A run with no revision is unversioned, as every run of generation 4 is.
  `ALTER TABLE workflow_runs
    DROP COLUMN workflow_name,
    DROP COLUMN task_name,
    ADD COLUMN parent_route_name text,
    ADD COLUMN parent_route_revision text,
    ADD COLUMN execution_revision text,
    ADD COLUMN graph_hash text,
    ADD COLUMN graph_presentation jsonb,
    ALTER COLUMN input DROP NOT NULL`,
  // A run wakes its parent by the parent's route, which it keeps: a failed
  // family retried later wakes each parent as the new engine does. The
  // route has no revision, the parent having none.
  `UPDATE workflow_runs AS child
  SET parent_route_name = parent.name
  FROM workflow_runs AS parent
  WHERE parent.id = child.parent_run_id`,
  `ALTER TABLE workflow_attempts
    DROP COLUMN worker_id,
    DROP COLUMN lease_token,
    DROP COLUMN idempotency_key,
    DROP COLUMN heartbeat_at,
    ALTER COLUMN input DROP NOT NULL`,
  `ALTER TABLE workflow_node_children
    DROP COLUMN item_key,
    ALTER COLUMN ordinal DROP NOT NULL,
    ALTER COLUMN ordinal DROP DEFAULT`,
  // Coordination needs no lease: a pass that loses a race is planned again.
  `DROP TABLE workflow_run_leases`,

  // Commands: none is queued, and the dead ones go, since their payloads
  // are not commands of the new engine and their runs have ended. The table
  // is empty when it is rebuilt.
  `DELETE FROM workflow_commands`,
  `DROP INDEX workflow_commands_claim_idx, workflow_commands_continue_dedup_idx`,
  `ALTER TABLE workflow_commands
    ADD COLUMN name text NOT NULL,
    ADD COLUMN revision text,
    ADD COLUMN dedupe text NOT NULL,
    ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY,
    ALTER COLUMN kind TYPE text USING kind::text,
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN payload DROP DEFAULT,
    ALTER COLUMN run_at DROP DEFAULT,
    DROP COLUMN workflow_name,
    DROP COLUMN task_name,
    DROP COLUMN activity_name,
    DROP COLUMN node_name,
    DROP COLUMN attempt_id,
    DROP COLUMN priority,
    DROP COLUMN lease_owner,
    DROP COLUMN reaped_at`,
  `DROP TYPE workflow_command_kind`,
  LANE_INDEX,
  `CREATE UNIQUE INDEX workflow_commands_fresh_idx ON workflow_commands (dedupe)
    WHERE lease_token IS NULL AND dead_at IS NULL`,
  `CREATE INDEX workflow_commands_released_idx ON workflow_commands (dedupe)
    WHERE lease_token IS NOT NULL AND lease_expires_at IS NULL
      AND dead_at IS NULL`,

  // Built over every run kept: with the keys, what takes time that grows
  // with the history.
  `CREATE INDEX workflow_runs_created_idx ON workflow_runs (created_at, id)`,
  // And over every child kept: a failed map retried later is read by them.
  ...CHILD_INDEXES,
]

/**
 * Generation 6 to 7: the nodes of durable workflows, which run nothing of
 * their own, and what a durable workflow's body asked each of its nodes to
 * be. Adds only: generation 6 runs read as they did.
 */
const TO_7: readonly string[] = [
  `ALTER TYPE workflow_node_kind ADD VALUE 'sleep'`,
  `ALTER TYPE workflow_node_kind ADD VALUE 'now'`,
  `ALTER TYPE workflow_node_kind ADD VALUE 'input'`,
  `ALTER TABLE workflow_nodes ADD COLUMN operation jsonb`,
]

const VERSIONED = `UPDATE workflow_schema_version SET version = ${SCHEMA_VERSION} WHERE id = 1`

/**
 * Generation 6 to 7, in place, one statement per entry; run them in one
 * transaction. It adds and never rewrites, so it takes no time that grows
 * with the history.
 */
export const MIGRATION_FROM_6: readonly string[] = [...TO_7, VERSIONED]

/** The migration from 6 as one script. */
export const MIGRATION_FROM_6_SQL = `BEGIN;\n\n${MIGRATION_FROM_6.join(';\n\n')};\n\nCOMMIT;\n`

/**
 * Generation 4 to 7, in place, one statement per entry; run them in one
 * transaction. See `README.md` beside this file for what it requires, and
 * for the identity keys it refuses to carry over.
 */
export const MIGRATION_FROM_4: readonly string[] = [
  ...BEFORE_KEYS,
  ...KEYS_IN_SQL,
  ...AFTER_KEYS,
  ...MIGRATION_FROM_6,
]

/** The migration as one script. */
export const MIGRATION_FROM_4_SQL = `BEGIN;\n\n${MIGRATION_FROM_4.join(';\n\n')};\n\nCOMMIT;\n`

/** Runs statements in one transaction, on the caller's `search_path`. */
const apply = (statements: readonly string[]) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(
      Effect.forEach(statements, (statement) => sql.unsafe(statement), {
        discard: true,
      }),
    ),
  )

export const install = apply(INSTALL)

/** Generation 6 to 7, in one transaction. */
export const migrateFrom6 = apply(MIGRATION_FROM_6)

const KEY_BATCH = 1_000

/**
 * The identity keys of stored runs, written by the functions that name the
 * keys of new runs: whatever a key holds, a start that repeats it finds it.
 * Runs are read a batch at a time, in the order of their ids.
 */
const carryKeys = Effect.gen(function* () {
  const sql = (yield* SqlClient.SqlClient).withoutTransforms()
  let after: string | undefined
  for (;;) {
    // As text: what a driver makes of JSON is its own choice.
    const rows = yield* sql.unsafe<{
      id: string
      idempotency: string | null
      uniquely: string | null
    }>(
      `SELECT id, idempotency_key::text AS idempotency,
              CASE WHEN unique_scope = 'all' THEN unique_key::text END AS uniquely
       FROM workflow_runs
       WHERE ($1::uuid IS NULL OR id > $1::uuid)
         AND (idempotency_key IS NOT NULL
              OR (unique_key IS NOT NULL AND unique_scope = 'all'))
       ORDER BY id
       LIMIT ${KEY_BATCH}`,
      [after ?? null],
    )
    if (rows.length === 0) return
    const keys = rows.flatMap(({ id, idempotency, uniquely }) => [
      ...(idempotency === null
        ? []
        : [[idempotencyKey(JSON.parse(idempotency)), id]]),
      ...(uniquely === null
        ? []
        : [[uniqueKey({ key: JSON.parse(uniquely), scope: 'all' }), id]]),
    ])
    yield* sql.unsafe(
      `INSERT INTO workflow_keys (key, run_id)
       SELECT x->>0, (x->>1)::uuid FROM jsonb_array_elements($1::jsonb) AS x`,
      [JSON.stringify(keys)],
    )
    after = rows.at(-1)!.id
  }
})

/**
 * The migration, in one transaction. It writes identity keys in the process,
 * and so carries over those the script must refuse.
 */
export const migrateFrom4 = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql.withTransaction(
    Effect.andThen(
      Effect.andThen(apply(BEFORE_KEYS), carryKeys),
      apply([...AFTER_KEYS, ...MIGRATION_FROM_6]),
    ),
  ),
)

/**
 * What the adapter's statements need of each table: `column type`, with `?`
 * where the column may be NULL. Types are named as `udt_name` names them.
 */
export const COLUMNS: Readonly<Record<string, string>> = {
  workflow_definitions: 'key text, value jsonb, created_at timestamptz',
  workflow_runs:
    'id uuid, kind workflow_run_kind, name text, status workflow_run_status, input jsonb?, output jsonb?, error jsonb?, parent_run_id uuid?, parent_node_name text?, parent_route_name text?, parent_route_revision text?, root_run_id uuid, tags jsonb, idempotency_key jsonb?, unique_key jsonb?, unique_scope text?, unique_behavior text?, execution_revision text?, graph_hash text?, graph_presentation jsonb?, version int4, active_since timestamptz, created_at timestamptz, updated_at timestamptz',
  workflow_nodes:
    'run_id uuid, name text, kind workflow_node_kind, status workflow_node_status, input jsonb?, output jsonb?, error jsonb?, selected_case text?, operation jsonb?, version int4, created_at timestamptz, updated_at timestamptz',
  workflow_attempts:
    'id uuid, run_id uuid, node_name text, child_key text, status workflow_attempt_status, attempt_number int4, retry_attempt_number int4, input jsonb?, output jsonb?, error jsonb?, dispatched_at timestamptz, completed_at timestamptz?',
  workflow_node_children:
    'run_id uuid, node_name text, child_key text, kind workflow_node_child_kind, status workflow_node_status, ordinal int4?, item jsonb?, input jsonb?, output jsonb?, error jsonb?, child_run_id uuid?, cancellation text?, current_attempt_id uuid?, attempt_count int4, version int4, created_at timestamptz, updated_at timestamptz',
  workflow_keys: 'key text, run_id uuid',
  workflow_commands:
    'id uuid, kind text, run_id uuid, revision text?, payload jsonb, run_at timestamptz, lease_token text?, lease_expires_at timestamptz?, delivery_count int4, last_error jsonb?, dead_at timestamptz?, created_at timestamptz, name text, dedupe text, seq int8',
  workflow_schedules:
    'name text, runnable_kind workflow_run_kind, runnable_name text, execution_revision text?, graph_hash text?, graph_presentation jsonb?, input jsonb?, tags jsonb, cron text?, time_zone text?, every_ms int8?, enabled bool, next_run_at timestamptz, last_slot_at timestamptz?, version int4, created_at timestamptz, updated_at timestamptz',
}

/** The indexes the adapter's statements are written for. */
export const INDEXES: readonly string[] = [
  'workflow_commands_lane_idx',
  'workflow_commands_fresh_idx',
  'workflow_commands_released_idx',
  'workflow_commands_run_idx',
  'workflow_commands_dead_idx',
  'workflow_keys_run_idx',
  'workflow_attempts_node_idx',
  'workflow_node_children_child_run_idx',
  'workflow_children_pending_ordinal_idx',
  'workflow_children_active_ordinal_idx',
  'workflow_children_ordinal_idx',
  'workflow_runs_created_idx',
  'workflow_runs_root_idx',
  'workflow_runs_prune_idx',
  'workflow_schedules_due_idx',
]

/**
 * Dies unless the schema on `search_path` is the generation this adapter is
 * written for, with the columns and indexes its statements need: a process
 * then cannot run against the wrong schema in either direction. Constraints
 * and the definitions of indexes are not compared.
 */
export const verify = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const columns = yield* sql.unsafe<{
    table_name: string
    column_name: string
    udt_name: string
    is_nullable: string
  }>(
    `SELECT table_name, column_name, udt_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = current_schema()`,
  )
  const found = new Map(
    columns.map((column) => [
      `${column.table_name}.${column.column_name}`,
      `${column.udt_name}${column.is_nullable === 'YES' ? '?' : ''}`,
    ]),
  )

  // Version first: when code and database disagree on the generation, that
  // says so, where the objects one of them lacks would only obscure it.
  const versions = found.has('workflow_schema_version.version')
    ? yield* sql.unsafe<{ version: number }>(
        'SELECT version FROM workflow_schema_version WHERE id = 1',
      )
    : []
  const installed = versions[0]?.version
  if (installed === undefined) {
    return yield* Effect.die(new Error('Missing workflow schema version'))
  }
  if (installed !== SCHEMA_VERSION) {
    const hint =
      installed < SCHEMA_VERSION
        ? `apply the schema upgrades up to generation ${SCHEMA_VERSION} first`
        : 'the database was upgraded for a newer engine'
    return yield* Effect.die(
      new Error(
        `Unsupported workflow schema generation [${installed}], expected [${SCHEMA_VERSION}]: ${hint}`,
      ),
    )
  }

  const wrong = Object.entries(COLUMNS).flatMap(([table, listed]) =>
    listed.split(', ').flatMap((column) => {
      const [name, type] = column.split(' ')
      const actual = found.get(`${table}.${name}`)
      return actual === type
        ? []
        : [`${table}.${name} (${actual ?? 'missing'}, expected ${type})`]
    }),
  )
  if (wrong.length > 0) {
    return yield* Effect.die(
      new Error(`Invalid workflow schema columns: ${wrong.join(', ')}`),
    )
  }

  const indexes = yield* sql.unsafe<{ indexname: string }>(
    'SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()',
  )
  const missing = INDEXES.filter(
    (name) => !indexes.some(({ indexname }) => indexname === name),
  )
  if (missing.length > 0) {
    return yield* Effect.die(
      new Error(`Missing workflow schema indexes: ${missing.join(', ')}`),
    )
  }
})
