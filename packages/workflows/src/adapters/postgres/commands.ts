import type { ContinueRunCommand } from '../../runtime/commands.ts'
import type {
  CommandReleaseOptions,
  RunCoordinationExecutor,
} from '../../runtime/executors.ts'
import type { WorkflowPostgresConnection } from './connection.ts'
import {
  COMMAND_LEASE_EXPIRED_ERROR,
  StaleAckError,
  toStoredError,
} from '../../runtime/errors.ts'
import {
  MAX_ERROR_BACKOFF_MS,
  RELEASE_BACKOFF_MS,
  UNROUTABLE_BACKOFF_MS,
  WORKFLOW_COMMANDS_CHANNEL,
} from './constants.ts'
import { id, json, one } from './query.ts'

export type PostgresWorkflowCommandContext = {
  readonly db: WorkflowPostgresConnection
  readonly maxDeliveries: number
}

type ReleasedCommandRow = {
  readonly dead_at: Date | null
  readonly delivery_count: number
  readonly last_error: unknown
  readonly run_at: Date
}

export type ClaimedCommandRow = {
  readonly id: string
  readonly payload: unknown
  readonly lease_token: string
}

export type ClaimWorker = {
  readonly workerId: string
  readonly leaseMs: number
}

/**
 * Parks a continue command outside the live-command partial unique index
 * without losing its history, so a requeued copy can take its place.
 */
export const DEAD_LEASE_PREFIX = 'dead:'

/**
 * Copies a continue command into a fresh row, coalescing with whatever live
 * wake-up already exists for the run, then consumes the source. The source
 * must still be outside the dedup index (leased or `dead:`-parked) while this
 * runs, or it would collide with its own copy.
 */
export const coalesceContinueSql = (params: {
  /** Predicate selecting the source row, also used by the DELETE. */
  readonly source: string
  readonly newId: string
  readonly runAt: string
  readonly deliveryCount: string
  readonly lastError: string
}) => `
  WITH coalesced AS (
    INSERT INTO workflow_commands (
      id,
      kind,
      run_id,
      workflow_name,
      payload,
      run_at,
      priority,
      delivery_count,
      last_error,
      created_at
    )
    SELECT
      ${params.newId},
      kind,
      run_id,
      workflow_name,
      payload,
      ${params.runAt},
      priority,
      ${params.deliveryCount},
      ${params.lastError},
      created_at
    FROM workflow_commands
    WHERE ${params.source}
    ON CONFLICT (run_id)
      WHERE kind = 'continue' AND lease_token IS NULL
    DO UPDATE
    SET run_at = LEAST(workflow_commands.run_at, EXCLUDED.run_at),
        delivery_count = GREATEST(
          workflow_commands.delivery_count,
          EXCLUDED.delivery_count
        ),
        last_error = CASE
          WHEN EXCLUDED.delivery_count > workflow_commands.delivery_count
            THEN EXCLUDED.last_error
          ELSE workflow_commands.last_error
        END
    RETURNING id
  )
  DELETE FROM workflow_commands
  WHERE ${params.source}
    AND EXISTS (SELECT 1 FROM coalesced)
`

// One source for the dead-letter threshold so the release path and the
// claim-time takeover cannot drift apart.
const atDeadLetterThreshold = (maxDeliveriesParam: string) =>
  `delivery_count + 1 >= ${maxDeliveriesParam}`

// Bounds the dead-letter drain inside a single claim call: a backlog of
// at-threshold expired commands (e.g. after a fleet-wide crash) must not
// stall one claimer for its full length — the poll loop retries shortly.
const MAX_DEAD_LETTERED_PER_CLAIM = 16

export const createPostgresWorkflowCommandHelpers = (
  ctx: PostgresWorkflowCommandContext,
) => {
  const { db, maxDeliveries } = ctx

  const releaseCommandRow = async (
    connection: WorkflowPostgresConnection,
    commandId: string,
    leaseToken: string,
    options: CommandReleaseOptions | undefined,
    { keepLease }: { readonly keepLease: boolean },
  ) => {
    const leaseAssignments = keepLease
      ? ''
      : `lease_owner = NULL,
         lease_token = NULL,
         lease_expires_at = NULL,`

    if (options?.error === undefined && options?.reason === undefined) {
      return one<ReleasedCommandRow>(
        connection,
        `
        UPDATE workflow_commands
        SET ${leaseAssignments}
            run_at = now() + ($3::int * interval '1 millisecond')
        WHERE id = $1 AND lease_token = $2
        RETURNING delivery_count, last_error, dead_at, run_at
      `,
        [commandId, leaseToken, RELEASE_BACKOFF_MS],
      )
    }

    // Unroutable commands back off slower than transient errors: nothing can
    // execute them until a deploy changes the registry, but they must still
    // count toward dead-lettering instead of looping forever.
    const backoffBaseMs =
      options.reason === 'unroutable'
        ? UNROUTABLE_BACKOFF_MS
        : RELEASE_BACKOFF_MS
    const error =
      options.error ??
      new Error('No implementation can execute this workflow command')

    return one<ReleasedCommandRow>(
      connection,
      `
      UPDATE workflow_commands
      SET ${leaseAssignments}
          delivery_count = delivery_count + 1,
          last_error = $3::jsonb,
          dead_at = CASE
            WHEN ${atDeadLetterThreshold('$4')} THEN now()
            ELSE dead_at
          END,
          run_at = now() + (
            LEAST(power(2, delivery_count + 1) * $5, $6)::int
            * interval '1 millisecond'
          )
      WHERE id = $1 AND lease_token = $2
      RETURNING delivery_count, last_error, dead_at, run_at
    `,
      [
        commandId,
        leaseToken,
        json(toStoredError(error)),
        maxDeliveries,
        backoffBaseMs,
        MAX_ERROR_BACKOFF_MS,
      ],
    )
  }

  const insertContinueCommand = async (
    command: ContinueRunCommand,
    runAt?: Date,
  ) => {
    // pg_notify piggybacks on the upsert so no enqueue path can forget the
    // wake-up hint; inside a transaction it is delivered on commit. Delayed
    // commands stay poll-only — waking workers for future work is noise.
    await db.query(
      `
      WITH upserted AS (
        INSERT INTO workflow_commands (
          id, kind, run_id, workflow_name, payload, run_at
        )
        VALUES ($1, 'continue', $2, $3, $4::jsonb, COALESCE($5, now()))
        ON CONFLICT (run_id) WHERE kind = 'continue' AND lease_token IS NULL
        DO UPDATE
        SET run_at = LEAST(workflow_commands.run_at, EXCLUDED.run_at),
            payload = EXCLUDED.payload,
            workflow_name = EXCLUDED.workflow_name
        RETURNING run_at
      )
      SELECT pg_notify('${WORKFLOW_COMMANDS_CHANNEL}', 'continue')
      FROM upserted
      WHERE run_at <= now()
    `,
      [id(), command.runId, command.workflowName, json(command), runAt ?? null],
    )
  }

  const releaseCommand = async (
    commandId: string,
    leaseToken: string,
    options?: CommandReleaseOptions,
  ) => {
    await releaseCommandRow(db, commandId, leaseToken, options, {
      keepLease: false,
    })
  }

  const releaseContinueCommand = async (
    commandId: string,
    leaseToken: string,
    options?: CommandReleaseOptions,
  ) => {
    await db.transaction(async (tx) => {
      const released = await releaseCommandRow(
        tx,
        commandId,
        leaseToken,
        options,
        { keepLease: true },
      )
      if (!released || released.dead_at !== null) return

      // Older releases could leave dead continuations inside the dedup index.
      // Keep their history but move them outside the live-command predicate so
      // they cannot absorb the wake-up being released here.
      await tx.query(
        `
        UPDATE workflow_commands AS dead
        SET lease_token = '${DEAD_LEASE_PREFIX}' || dead.id::text
        WHERE dead.id <> $1
          AND kind = 'continue'
          AND dead_at IS NOT NULL
          AND lease_token IS NULL
          AND run_id = (
            SELECT run_id
            FROM workflow_commands
            WHERE id = $1 AND lease_token = $2
          )
      `,
        [commandId, leaseToken],
      )

      // Copy while the released row is still leased, so it never enters the
      // partial unique index itself. ON CONFLICT keeps a newer pending payload
      // and only carries forward earlier scheduling or newer retry metadata;
      // the claimed row is deleted only after one live wake-up is guaranteed.
      await tx.query(
        coalesceContinueSql({
          source: 'id = $1 AND lease_token = $2',
          newId: '$3',
          runAt: 'run_at',
          deliveryCount: 'delivery_count',
          lastError: 'last_error',
        }),
        [commandId, leaseToken, id()],
      )
    })
  }

  const claimCommand = async (
    conditions: readonly string[],
    params: readonly unknown[],
    worker: ClaimWorker,
  ) => {
    const candidateQuery = (condition: string) => `
      SELECT id, priority, run_at, created_at
      FROM workflow_commands
      WHERE run_at <= now()
        AND (lease_token IS NULL OR lease_expires_at <= now())
        AND dead_at IS NULL
        AND (${condition})
      ORDER BY priority DESC, run_at ASC, created_at ASC, id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `
    const candidateSql =
      conditions.length === 1
        ? `candidate AS (${candidateQuery(conditions[0]!)})`
        : `
          -- Per-kind probes preserve the existing ordered claim index while
          -- the final choice keeps activity and task work globally ordered.
          ${conditions
            .map(
              (condition, index) =>
                `candidate_${index} AS (${candidateQuery(condition)})`,
            )
            .join(', ')},
          eligible_candidates AS (
            ${conditions
              .map((_, index) => `SELECT * FROM candidate_${index}`)
              .join(' UNION ALL ')}
          ),
          candidate AS (
            SELECT id
            FROM eligible_candidates
            ORDER BY priority DESC, run_at ASC, created_at ASC, id ASC
            LIMIT 1
          )
        `
    // Taking over an expired lease means the previous delivery died without
    // any release — the one failure mode release-time counting can never see
    // (a crashed worker persists nothing). Counting it here is what makes
    // poison commands reach `dead_at` instead of crash-looping forever; at
    // the threshold the row is dead-lettered instead of delivered. SET
    // expressions read pre-update values, so `lease_token IS NOT NULL`
    // identifies a takeover (the candidate filter already proved expiry).
    // The lease fields are written even on the dead branch: a dead row with
    // lease_token NULL would enter the continue-dedup partial unique index
    // and collide with a coexisting fresh continue row for the same run.
    // last_error only fills a gap — a real error from a prior release is
    // better dead-letter diagnostics than the synthetic lease message.
    const takeover = 'lease_token IS NOT NULL'
    const owner = `$${params.length + 1}`
    const token = `$${params.length + 2}`
    const lease = `$${params.length + 3}`
    const threshold = `$${params.length + 4}`
    const leaseError = `$${params.length + 5}`
    const claimSql = `
      WITH ${candidateSql}
      UPDATE workflow_commands
      SET delivery_count = delivery_count
            + CASE WHEN ${takeover} THEN 1 ELSE 0 END,
          last_error = CASE
            WHEN ${takeover} AND last_error IS NULL THEN ${leaseError}::jsonb
            ELSE last_error
          END,
          dead_at = CASE
            WHEN ${takeover} AND ${atDeadLetterThreshold(threshold)} THEN now()
            ELSE dead_at
          END,
          lease_owner = ${owner},
          lease_token = ${token},
          lease_expires_at = now() + (${lease}::int * interval '1 millisecond')
      WHERE id = (SELECT id FROM candidate)
      RETURNING *
    `
    const leaseExpiredErrorJson = json(COMMAND_LEASE_EXPIRED_ERROR)
    for (let drained = 0; drained <= MAX_DEAD_LETTERED_PER_CLAIM; drained++) {
      const claimed = await one<ClaimedCommandRow & { dead_at: Date | null }>(
        db,
        claimSql,
        [
          ...params,
          worker.workerId,
          id(),
          worker.leaseMs,
          maxDeliveries,
          leaseExpiredErrorJson,
        ],
      )
      if (!claimed) return null
      if (claimed.dead_at == null) return claimed
      // The candidate was dead-lettered, not delivered — keep claiming so a
      // single poison command can't starve the worker of the work behind it.
    }
    return null
  }

  const ackCommand = async (commandId: string, leaseToken: string) => {
    const deleted = await one<{ id: string }>(
      db,
      `
      DELETE FROM workflow_commands
      WHERE id = $1 AND lease_token = $2
      RETURNING id
    `,
      [commandId, leaseToken],
    )

    if (!deleted) throw new StaleAckError()
  }

  return {
    insertContinueCommand,
    releaseCommand,
    releaseContinueCommand,
    claimCommand,
    ackCommand,
  }
}

export const createRunCoordinationExecutor = (
  ctx: PostgresWorkflowCommandContext,
): RunCoordinationExecutor => {
  const {
    insertContinueCommand,
    releaseContinueCommand,
    claimCommand,
    ackCommand,
  } = createPostgresWorkflowCommandHelpers(ctx)

  return {
    enqueue: (command) => insertContinueCommand(command),
    enqueueDelayed: (command, runAt) => insertContinueCommand(command, runAt),
    async claim(worker) {
      if (worker.workflowNames.length === 0) return null
      const names = worker.workflowNames
        .map((_, index) => `$${index + 1}`)
        .join(', ')
      const claimed = await claimCommand(
        [`kind = 'continue' AND workflow_name IN (${names})`],
        worker.workflowNames,
        worker,
      )
      if (!claimed) return null
      return {
        id: claimed.id,
        command: claimed.payload as ContinueRunCommand,
        leaseToken: claimed.lease_token,
      }
    },
    ack: (command) => ackCommand(command.id, command.leaseToken),
    release: (command, options) =>
      releaseContinueCommand(command.id, command.leaseToken, options),
  }
}
