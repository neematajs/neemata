import type { WorkflowPostgresConnection } from '../postgres.ts'
import { WORKFLOW_POSTGRES_SCHEMA_MANIFEST } from '../postgres.ts'

export async function installPostgresWorkflowSchemaForTesting(
  db: WorkflowPostgresConnection,
) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS workflow_schema_version (
      id integer PRIMARY KEY DEFAULT 1,
      version integer NOT NULL,
      installed_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT workflow_schema_version_singleton_chk CHECK (id = 1)
    )
  `)
  await db.query(
    `
      INSERT INTO workflow_schema_version (id, version)
      VALUES (1, $1)
      ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version
    `,
    [WORKFLOW_POSTGRES_SCHEMA_MANIFEST.version],
  )
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_run_kind') THEN
        CREATE TYPE workflow_run_kind AS ENUM ('workflow', 'task');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_node_kind') THEN
        CREATE TYPE workflow_node_kind AS ENUM (
          'activity',
          'task',
          'workflow',
          'branch',
          'parallel',
          'mapTask',
          'mapWorkflow'
        );
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_node_child_kind') THEN
        CREATE TYPE workflow_node_child_kind AS ENUM (
          'activity',
          'task',
          'workflow'
        );
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_run_status') THEN
        CREATE TYPE workflow_run_status AS ENUM (
          'queued',
          'running',
          'waiting',
          'cancelling',
          'cancelled',
          'failed',
          'completed'
        );
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_node_status') THEN
        CREATE TYPE workflow_node_status AS ENUM (
          'pending',
          'running',
          'waiting',
          'cancelling',
          'cancelled',
          'failed',
          'completed'
        );
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_attempt_status') THEN
        CREATE TYPE workflow_attempt_status AS ENUM (
          'started',
          'completed',
          'failed',
          'timedOut',
          'cancelled'
        );
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_command_kind') THEN
        CREATE TYPE workflow_command_kind AS ENUM (
          'continue',
          'activity',
          'task'
        );
      END IF;
    END
    $$;
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS workflow_schedules (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      runnable_kind workflow_run_kind NOT NULL,
      runnable_name text NOT NULL,
      input jsonb NOT NULL,
      tags jsonb NOT NULL DEFAULT '{}'::jsonb,
      cron text,
      every_ms bigint,
      enabled boolean NOT NULL,
      next_run_at timestamptz NOT NULL,
      last_slot_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT workflow_schedules_name_key UNIQUE (name),
      CONSTRAINT workflow_schedules_cadence_chk CHECK ((cron IS NULL) <> (every_ms IS NULL))
    )
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS workflow_schedules_due_idx
    ON workflow_schedules (enabled, next_run_at)
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id uuid PRIMARY KEY,
      kind workflow_run_kind NOT NULL,
      name text NOT NULL,
      workflow_name text NOT NULL,
      task_name text,
      status workflow_run_status NOT NULL,
      input jsonb NOT NULL,
      output jsonb,
      error jsonb,
      parent_run_id uuid,
      parent_node_name text,
      root_run_id uuid NOT NULL,
      tags jsonb NOT NULL DEFAULT '{}'::jsonb,
      idempotency_key jsonb,
      version integer NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    )
  `)
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_idempotency_idx
    ON workflow_runs (idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS workflow_runs_parent_idx
    ON workflow_runs (parent_run_id)
    WHERE parent_run_id IS NOT NULL
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS workflow_runs_root_idx
    ON workflow_runs (root_run_id)
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS workflow_runs_prune_idx
    ON workflow_runs (status, updated_at)
    WHERE parent_run_id IS NULL
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS workflow_runs_input_gin_idx
    ON workflow_runs USING gin (input jsonb_path_ops)
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS workflow_runs_tags_gin_idx
    ON workflow_runs USING gin (tags jsonb_path_ops)
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS workflow_nodes (
      run_id uuid NOT NULL,
      name text NOT NULL,
      kind workflow_node_kind NOT NULL,
      status workflow_node_status NOT NULL,
      input jsonb,
      output jsonb,
      error jsonb,
      selected_case text,
      version integer NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (run_id, name)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS workflow_attempts (
      id uuid PRIMARY KEY,
      run_id uuid NOT NULL,
      node_name text NOT NULL,
      child_key text NOT NULL,
      status workflow_attempt_status NOT NULL,
      worker_id text,
      lease_token text,
      attempt_number integer NOT NULL,
      input jsonb NOT NULL,
      idempotency_key jsonb,
      output jsonb,
      error jsonb,
      dispatched_at timestamptz NOT NULL,
      heartbeat_at timestamptz,
      completed_at timestamptz,
      CONSTRAINT workflow_attempts_child_attempt_key
        UNIQUE (run_id, node_name, child_key, attempt_number)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS workflow_node_children (
      run_id uuid NOT NULL,
      node_name text NOT NULL,
      child_key text NOT NULL,
      kind workflow_node_child_kind NOT NULL,
      status workflow_node_status NOT NULL,
      ordinal integer NOT NULL DEFAULT 0,
      item_key text,
      item jsonb,
      input jsonb,
      output jsonb,
      error jsonb,
      child_run_id uuid,
      current_attempt_id uuid,
      attempt_count integer NOT NULL DEFAULT 0,
      version integer NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (run_id, node_name, child_key)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS workflow_run_leases (
      run_id uuid PRIMARY KEY,
      lease_token text NOT NULL,
      version integer NOT NULL,
      expires_at timestamptz NOT NULL
    )
  `)
  // dropped in beta.5: run event history is gone; clean stale test databases
  await db.query('DROP TABLE IF EXISTS workflow_run_events')
  await db.query(`
    CREATE TABLE IF NOT EXISTS workflow_commands (
      id uuid PRIMARY KEY,
      kind workflow_command_kind NOT NULL,
      run_id uuid NOT NULL,
      workflow_name text,
      task_name text,
      activity_name text,
      node_name text,
      attempt_id uuid,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      run_at timestamptz NOT NULL DEFAULT now(),
      priority integer NOT NULL DEFAULT 0,
      lease_owner text,
      lease_token text,
      lease_expires_at timestamptz,
      delivery_count integer NOT NULL DEFAULT 0,
      last_error jsonb,
      dead_at timestamptz,
      reaped_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await db.query(`
    ALTER TABLE workflow_commands
    ADD COLUMN IF NOT EXISTS delivery_count integer NOT NULL DEFAULT 0
  `)
  await db.query(`
    ALTER TABLE workflow_commands
    ADD COLUMN IF NOT EXISTS last_error jsonb
  `)
  await db.query(`
    ALTER TABLE workflow_commands
    ADD COLUMN IF NOT EXISTS dead_at timestamptz,
    ADD COLUMN IF NOT EXISTS reaped_at timestamptz
  `)
  // drop-and-create: pre-existing test databases may hold the older
  // non-partial shape under the same name; the advisory lock serializes
  // concurrent installers (integration spec files share one database)
  await db.query(`
    DO $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('workflow_commands_claim_idx_install'));
      IF NOT EXISTS (
        SELECT 1
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'workflow_commands_claim_idx'
          AND i.indpred IS NOT NULL
      ) THEN
        DROP INDEX IF EXISTS workflow_commands_claim_idx;
        CREATE INDEX workflow_commands_claim_idx
        ON workflow_commands (kind, priority DESC, run_at, created_at, id)
        WHERE dead_at IS NULL;
      END IF;
    END
    $$;
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS workflow_commands_dead_idx
    ON workflow_commands (dead_at)
    WHERE dead_at IS NOT NULL
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS workflow_commands_run_idx
    ON workflow_commands (run_id)
  `)
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS workflow_commands_continue_dedup_idx
    ON workflow_commands (run_id)
    WHERE kind = 'continue' AND lease_token IS NULL
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS workflow_attempts_node_idx
    ON workflow_attempts (run_id, node_name)
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS workflow_node_children_node_idx
    ON workflow_node_children (run_id, node_name)
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS workflow_node_children_child_run_idx
    ON workflow_node_children (child_run_id)
  `)
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_runs_parent_run_fk') THEN
        ALTER TABLE workflow_runs
        ADD CONSTRAINT workflow_runs_parent_run_fk
        FOREIGN KEY (parent_run_id)
        REFERENCES workflow_runs(id)
        ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_runs_root_run_fk') THEN
        ALTER TABLE workflow_runs
        ADD CONSTRAINT workflow_runs_root_run_fk
        FOREIGN KEY (root_run_id)
        REFERENCES workflow_runs(id)
        ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_runs_parent_node_fk') THEN
        ALTER TABLE workflow_runs
        ADD CONSTRAINT workflow_runs_parent_node_fk
        FOREIGN KEY (parent_run_id, parent_node_name)
        REFERENCES workflow_nodes(run_id, name)
        ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_nodes_run_fk') THEN
        ALTER TABLE workflow_nodes
        ADD CONSTRAINT workflow_nodes_run_fk
        FOREIGN KEY (run_id)
        REFERENCES workflow_runs(id)
        ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_attempts_node_fk') THEN
        ALTER TABLE workflow_attempts
        ADD CONSTRAINT workflow_attempts_node_fk
        FOREIGN KEY (run_id, node_name)
        REFERENCES workflow_nodes(run_id, name)
        ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_attempts_child_attempt_key') THEN
        ALTER TABLE workflow_attempts
        ADD CONSTRAINT workflow_attempts_child_attempt_key
        UNIQUE (run_id, node_name, child_key, attempt_number);
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_node_children_run_fk') THEN
        ALTER TABLE workflow_node_children
        ADD CONSTRAINT workflow_node_children_run_fk
        FOREIGN KEY (run_id)
        REFERENCES workflow_runs(id)
        ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_node_children_node_fk') THEN
        ALTER TABLE workflow_node_children
        ADD CONSTRAINT workflow_node_children_node_fk
        FOREIGN KEY (run_id, node_name)
        REFERENCES workflow_nodes(run_id, name)
        ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_node_children_child_run_fk') THEN
        ALTER TABLE workflow_node_children
        ADD CONSTRAINT workflow_node_children_child_run_fk
        FOREIGN KEY (child_run_id)
        REFERENCES workflow_runs(id)
        ON DELETE SET NULL;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_node_children_current_attempt_fk') THEN
        ALTER TABLE workflow_node_children
        ADD CONSTRAINT workflow_node_children_current_attempt_fk
        FOREIGN KEY (current_attempt_id)
        REFERENCES workflow_attempts(id)
        ON DELETE SET NULL;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_run_leases_run_fk') THEN
        ALTER TABLE workflow_run_leases
        ADD CONSTRAINT workflow_run_leases_run_fk
        FOREIGN KEY (run_id)
        REFERENCES workflow_runs(id)
        ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_commands_run_fk') THEN
        ALTER TABLE workflow_commands
        ADD CONSTRAINT workflow_commands_run_fk
        FOREIGN KEY (run_id)
        REFERENCES workflow_runs(id)
        ON DELETE CASCADE;
      END IF;
    END
    $$;
  `)
}
