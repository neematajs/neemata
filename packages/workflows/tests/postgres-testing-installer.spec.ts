import { PGlite } from '@electric-sql/pglite'
import { describe, expect, test } from 'vitest'

import { createPostgresWorkflowConnection } from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'

describe('test installer in a second schema', () => {
  const constraintNames = async (db: PGlite, schema: string) =>
    (
      await db.query<{ name: string }>(
        `
          SELECT c.conname AS name
          FROM pg_constraint c
          JOIN pg_class rel ON rel.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = rel.relnamespace
          WHERE n.nspname = $1 AND rel.relname LIKE 'workflow_%'
          ORDER BY c.conname
        `,
        [schema],
      )
    ).rows.map((row) => row.name)

  const claimIndexes = async (db: PGlite) =>
    (
      await db.query<{ schema: string; partial: boolean }>(`
        SELECT n.nspname AS schema, i.indpred IS NOT NULL AS partial
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'workflow_commands_claim_idx'
        ORDER BY n.nspname
      `)
    ).rows

  test('installs the foreign keys and the claim index the first schema already has', async () => {
    const db = new PGlite()
    const connection = createPostgresWorkflowConnection(db)
    await installPostgresWorkflowSchemaForTesting(connection)
    const expected = await constraintNames(db, 'public')
    expect(expected).toContain('workflow_commands_run_fk')

    await db.exec('CREATE SCHEMA second; SET search_path = second, public')
    await installPostgresWorkflowSchemaForTesting(connection)

    expect(await constraintNames(db, 'second')).toStrictEqual(expected)
    expect(await claimIndexes(db)).toStrictEqual([
      { schema: 'public', partial: true },
      { schema: 'second', partial: true },
    ])
    // Without the foreign key this insert of an orphan command succeeds.
    await expect(
      db.query(`
        INSERT INTO second.workflow_commands (id, kind, run_id, payload)
        VALUES (gen_random_uuid(), 'continue', gen_random_uuid(), '{}')
      `),
    ).rejects.toThrow(/workflow_commands_run_fk/)
  })

  test('replaces a legacy claim index of its own schema only', async () => {
    const db = new PGlite()
    const connection = createPostgresWorkflowConnection(db)
    await installPostgresWorkflowSchemaForTesting(connection)
    // `public` keeps the current shape while `second` gets the legacy one:
    // an unscoped lookup is satisfied by the former and never fixes the latter.
    await db.exec(`
      CREATE SCHEMA second;
      SET search_path = second, public;
    `)
    await installPostgresWorkflowSchemaForTesting(connection)
    await db.exec(`
      DROP INDEX second.workflow_commands_claim_idx;
      CREATE INDEX workflow_commands_claim_idx
      ON second.workflow_commands (kind, priority DESC, run_at, created_at, id);
    `)

    await installPostgresWorkflowSchemaForTesting(connection)

    expect(await claimIndexes(db)).toStrictEqual([
      { schema: 'public', partial: true },
      { schema: 'second', partial: true },
    ])
  })
})
