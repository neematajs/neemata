/**
 * Schema generation 4 as `@nmtjs/workflows@0.18.0-alpha.4`, the last release
 * of the Promise engine, installs it, frozen: what the migration to
 * generation 6 starts from. Recorded from that release's
 * `installPostgresWorkflowSchemaForTesting` (tag `v0.18.0-alpha.4`,
 * `src/adapters/postgres/testing.ts`), one statement per query with the
 * version bound, less the two optional GIN search indexes a fresh install of
 * generation 6 does not create either.
 */
export const GENERATION_4: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS workflow_schema_version (
    id integer PRIMARY KEY DEFAULT 1,
    version integer NOT NULL,
    installed_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT workflow_schema_version_singleton_chk CHECK (id = 1)
  )`,
  `INSERT INTO workflow_schema_version (id, version)
  VALUES (1, 4)
  ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version`,
  `DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_run_kind' AND typnamespace = current_schema()::regnamespace) THEN
      CREATE TYPE workflow_run_kind AS ENUM ('workflow', 'task');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_node_kind' AND typnamespace = current_schema()::regnamespace) THEN
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
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_node_child_kind' AND typnamespace = current_schema()::regnamespace) THEN
      CREATE TYPE workflow_node_child_kind AS ENUM (
        'activity',
        'task',
        'workflow'
      );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_run_status' AND typnamespace = current_schema()::regnamespace) THEN
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
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_node_status' AND typnamespace = current_schema()::regnamespace) THEN
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
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_attempt_status' AND typnamespace = current_schema()::regnamespace) THEN
      CREATE TYPE workflow_attempt_status AS ENUM (
        'started',
        'completed',
        'failed',
        'timedOut',
        'cancelled'
      );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_command_kind' AND typnamespace = current_schema()::regnamespace) THEN
      CREATE TYPE workflow_command_kind AS ENUM (
        'continue',
        'activity',
        'task'
      );
    END IF;
  END
  $$;`,
  `CREATE TABLE IF NOT EXISTS workflow_schedules (
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
  )`,
  `CREATE INDEX IF NOT EXISTS workflow_schedules_due_idx
  ON workflow_schedules (enabled, next_run_at)`,
  `CREATE TABLE IF NOT EXISTS workflow_runs (
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
    unique_key jsonb,
    unique_scope text,
    unique_behavior text,
    version integer NOT NULL,
    active_since timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`,
  `ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS active_since timestamptz,
  ADD COLUMN IF NOT EXISTS unique_key jsonb,
  ADD COLUMN IF NOT EXISTS unique_scope text,
  ADD COLUMN IF NOT EXISTS unique_behavior text`,
  `UPDATE workflow_runs SET active_since = created_at WHERE active_since IS NULL`,
  `ALTER TABLE workflow_runs ALTER COLUMN active_since SET NOT NULL, ALTER COLUMN active_since SET DEFAULT now()`,
  `CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_idempotency_idx
  ON workflow_runs (idempotency_key)
  WHERE idempotency_key IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_unique_active_idx
  ON workflow_runs (unique_key)
  WHERE unique_key IS NOT NULL AND unique_scope = 'active'
    AND status NOT IN ('completed', 'cancelled', 'failed')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_unique_all_idx
  ON workflow_runs (unique_key)
  WHERE unique_key IS NOT NULL AND unique_scope = 'all'`,
  `CREATE INDEX IF NOT EXISTS workflow_runs_parent_idx
  ON workflow_runs (parent_run_id)
  WHERE parent_run_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS workflow_runs_root_idx
  ON workflow_runs (root_run_id)`,
  `CREATE INDEX IF NOT EXISTS workflow_runs_prune_idx
  ON workflow_runs (status, updated_at)
  WHERE parent_run_id IS NULL`,
  `CREATE TABLE IF NOT EXISTS workflow_nodes (
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
  )`,
  `CREATE TABLE IF NOT EXISTS workflow_attempts (
    id uuid PRIMARY KEY,
    run_id uuid NOT NULL,
    node_name text NOT NULL,
    child_key text NOT NULL,
    status workflow_attempt_status NOT NULL,
    worker_id text,
    lease_token text,
    attempt_number integer NOT NULL,
    retry_attempt_number integer NOT NULL,
    input jsonb NOT NULL,
    idempotency_key jsonb,
    output jsonb,
    error jsonb,
    dispatched_at timestamptz NOT NULL,
    heartbeat_at timestamptz,
    completed_at timestamptz,
    CONSTRAINT workflow_attempts_child_attempt_key
      UNIQUE (run_id, node_name, child_key, attempt_number)
  )`,
  `ALTER TABLE workflow_attempts ADD COLUMN IF NOT EXISTS retry_attempt_number integer`,
  `UPDATE workflow_attempts SET retry_attempt_number = attempt_number WHERE retry_attempt_number IS NULL`,
  `ALTER TABLE workflow_attempts ALTER COLUMN retry_attempt_number SET NOT NULL`,
  `CREATE TABLE IF NOT EXISTS workflow_node_children (
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
    cancellation text,
    current_attempt_id uuid,
    attempt_count integer NOT NULL DEFAULT 0,
    version integer NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (run_id, node_name, child_key)
  )`,
  `CREATE TABLE IF NOT EXISTS workflow_run_leases (
    run_id uuid PRIMARY KEY,
    lease_token text NOT NULL,
    version integer NOT NULL,
    expires_at timestamptz NOT NULL
  )`,
  `DROP TABLE IF EXISTS workflow_run_events`,
  `CREATE TABLE IF NOT EXISTS workflow_commands (
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
  )`,
  `ALTER TABLE workflow_commands
  ADD COLUMN IF NOT EXISTS delivery_count integer NOT NULL DEFAULT 0`,
  `ALTER TABLE workflow_commands
  ADD COLUMN IF NOT EXISTS last_error jsonb`,
  `ALTER TABLE workflow_commands
  ADD COLUMN IF NOT EXISTS dead_at timestamptz,
  ADD COLUMN IF NOT EXISTS reaped_at timestamptz`,
  `DO $$
  DECLARE
    existing regclass;
    is_partial boolean;
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('workflow_commands_claim_idx_install'));
    SELECT i.indexrelid::regclass, i.indpred IS NOT NULL
    INTO existing, is_partial
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'workflow_commands_claim_idx'
      AND i.indrelid = 'workflow_commands'::regclass;
    IF existing IS NOT NULL AND NOT is_partial THEN
      EXECUTE format('DROP INDEX %s', existing);
    END IF;
    IF existing IS NULL OR NOT is_partial THEN
      CREATE INDEX workflow_commands_claim_idx
      ON workflow_commands (kind, priority DESC, run_at, created_at, id)
      WHERE dead_at IS NULL;
    END IF;
  END
  $$;`,
  `CREATE INDEX IF NOT EXISTS workflow_commands_dead_idx
  ON workflow_commands (dead_at)
  WHERE dead_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS workflow_commands_run_idx
  ON workflow_commands (run_id)`,
  `CREATE INDEX IF NOT EXISTS workflow_commands_attempt_idx
  ON workflow_commands (attempt_id)
  WHERE attempt_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS workflow_commands_continue_dedup_idx
  ON workflow_commands (run_id)
  WHERE kind = 'continue' AND lease_token IS NULL`,
  `CREATE INDEX IF NOT EXISTS workflow_attempts_node_idx
  ON workflow_attempts (run_id, node_name)`,
  `CREATE INDEX IF NOT EXISTS workflow_node_children_node_idx
  ON workflow_node_children (run_id, node_name)`,
  `CREATE INDEX IF NOT EXISTS workflow_node_children_child_run_idx
  ON workflow_node_children (child_run_id)`,
  `DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'workflow_runs_parent_run_fk' AND conrelid = 'workflow_runs'::regclass
    ) THEN
      ALTER TABLE workflow_runs
      ADD CONSTRAINT workflow_runs_parent_run_fk
      FOREIGN KEY (parent_run_id)
      REFERENCES workflow_runs(id)
      ON DELETE CASCADE;
    END IF;
  
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'workflow_runs_root_run_fk' AND conrelid = 'workflow_runs'::regclass
    ) THEN
      ALTER TABLE workflow_runs
      ADD CONSTRAINT workflow_runs_root_run_fk
      FOREIGN KEY (root_run_id)
      REFERENCES workflow_runs(id)
      ON DELETE CASCADE;
    END IF;
  
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'workflow_runs_parent_node_fk' AND conrelid = 'workflow_runs'::regclass
    ) THEN
      ALTER TABLE workflow_runs
      ADD CONSTRAINT workflow_runs_parent_node_fk
      FOREIGN KEY (parent_run_id, parent_node_name)
      REFERENCES workflow_nodes(run_id, name)
      ON DELETE CASCADE;
    END IF;
  
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'workflow_nodes_run_fk' AND conrelid = 'workflow_nodes'::regclass
    ) THEN
      ALTER TABLE workflow_nodes
      ADD CONSTRAINT workflow_nodes_run_fk
      FOREIGN KEY (run_id)
      REFERENCES workflow_runs(id)
      ON DELETE CASCADE;
    END IF;
  
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'workflow_attempts_node_fk' AND conrelid = 'workflow_attempts'::regclass
    ) THEN
      ALTER TABLE workflow_attempts
      ADD CONSTRAINT workflow_attempts_node_fk
      FOREIGN KEY (run_id, node_name)
      REFERENCES workflow_nodes(run_id, name)
      ON DELETE CASCADE;
    END IF;
  
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'workflow_attempts_child_attempt_key' AND conrelid = 'workflow_attempts'::regclass
    ) THEN
      ALTER TABLE workflow_attempts
      ADD CONSTRAINT workflow_attempts_child_attempt_key
      UNIQUE (run_id, node_name, child_key, attempt_number);
    END IF;
  
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'workflow_node_children_run_fk' AND conrelid = 'workflow_node_children'::regclass
    ) THEN
      ALTER TABLE workflow_node_children
      ADD CONSTRAINT workflow_node_children_run_fk
      FOREIGN KEY (run_id)
      REFERENCES workflow_runs(id)
      ON DELETE CASCADE;
    END IF;
  
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'workflow_node_children_node_fk' AND conrelid = 'workflow_node_children'::regclass
    ) THEN
      ALTER TABLE workflow_node_children
      ADD CONSTRAINT workflow_node_children_node_fk
      FOREIGN KEY (run_id, node_name)
      REFERENCES workflow_nodes(run_id, name)
      ON DELETE CASCADE;
    END IF;
  
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'workflow_node_children_child_run_fk' AND conrelid = 'workflow_node_children'::regclass
    ) THEN
      ALTER TABLE workflow_node_children
      ADD CONSTRAINT workflow_node_children_child_run_fk
      FOREIGN KEY (child_run_id)
      REFERENCES workflow_runs(id)
      ON DELETE SET NULL;
    END IF;
  
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'workflow_node_children_current_attempt_fk' AND conrelid = 'workflow_node_children'::regclass
    ) THEN
      ALTER TABLE workflow_node_children
      ADD CONSTRAINT workflow_node_children_current_attempt_fk
      FOREIGN KEY (current_attempt_id)
      REFERENCES workflow_attempts(id)
      ON DELETE SET NULL;
    END IF;
  
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'workflow_run_leases_run_fk' AND conrelid = 'workflow_run_leases'::regclass
    ) THEN
      ALTER TABLE workflow_run_leases
      ADD CONSTRAINT workflow_run_leases_run_fk
      FOREIGN KEY (run_id)
      REFERENCES workflow_runs(id)
      ON DELETE CASCADE;
    END IF;
  
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'workflow_commands_run_fk' AND conrelid = 'workflow_commands'::regclass
    ) THEN
      ALTER TABLE workflow_commands
      ADD CONSTRAINT workflow_commands_run_fk
      FOREIGN KEY (run_id)
      REFERENCES workflow_runs(id)
      ON DELETE CASCADE;
    END IF;
  END
  $$;`,
]
