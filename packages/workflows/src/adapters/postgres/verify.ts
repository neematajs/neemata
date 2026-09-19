import type { WorkflowPostgresConnection } from './connection.ts'
import { WORKFLOW_POSTGRES_SCHEMA_MANIFEST as MANIFEST } from './manifest.ts'
import { many, one } from './query.ts'

// node-postgres leaves `name[]` columns unparsed, so array literals arrive as
// the `{a,b}` text form.
const stringArray = (value: unknown): readonly string[] => {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value !== 'string') return []
  const content =
    value.startsWith('{') && value.endsWith('}') ? value.slice(1, -1) : value
  if (!content) return []
  return content.split(',').map((item) => item.replaceAll('"', ''))
}

const sameStringArray = (left: unknown, right: readonly string[]) => {
  const normalized = stringArray(left)
  return (
    normalized.length === right.length &&
    normalized.every((item, index) => item === right[index])
  )
}

const normalizeIndexPredicate = (value: unknown) =>
  typeof value === 'string'
    ? value
        .replaceAll('"', '')
        .replace(/[()]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
    : undefined

const assertNone = (label: string, names: readonly string[]) => {
  if (names.length === 0) return
  throw new Error(`${label}: ${names.join(', ')}`)
}

const checkObjects = async (db: WorkflowPostgresConnection) => {
  const [enums, tables, constraints, indexes] = await Promise.all([
    many<{ name: string }>(
      db,
      `
        SELECT t.typname AS name
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = current_schema()
          AND t.typname = ANY($1)
      `,
      [MANIFEST.enums],
    ),
    many<{ name: string }>(
      db,
      `
        SELECT tablename AS name
        FROM pg_tables
        WHERE schemaname = current_schema()
          AND tablename = ANY($1)
      `,
      [MANIFEST.tables],
    ),
    many<{ name: string }>(
      db,
      `
        SELECT c.conname AS name
        FROM pg_constraint c
        JOIN pg_class rel ON rel.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE n.nspname = current_schema()
          AND c.conname = ANY($1)
      `,
      [MANIFEST.constraints],
    ),
    many<{ name: string }>(
      db,
      `
        SELECT indexname AS name
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = ANY($1)
      `,
      [MANIFEST.indexes],
    ),
  ])

  const existing = new Set(
    [...enums, ...tables, ...constraints, ...indexes].map((row) => row.name),
  )
  assertNone(
    'Missing workflow Postgres schema objects',
    [
      ...MANIFEST.enums,
      ...MANIFEST.tables,
      ...MANIFEST.constraints,
      ...MANIFEST.indexes,
    ].filter((name) => !existing.has(name)),
  )
}

// Version first: when code and database disagree on schema generation,
// "expected vN, found vM" diagnoses it (stale build / missed migration),
// whereas the structural mismatches below would only obscure that cause.
const checkVersion = async (db: WorkflowPostgresConnection) => {
  const version = await one<{ id: number; version: number }>(
    db,
    `
      SELECT id, version
      FROM workflow_schema_version
      WHERE id = 1
    `,
  )
  if (!version) throw new Error('Missing workflow Postgres schema version')
  if (version.version !== MANIFEST.version) {
    throw new Error(
      `Unsupported workflow Postgres schema version [${version.version}], expected [${MANIFEST.version}]`,
    )
  }
}

const checkEnums = async (db: WorkflowPostgresConnection) => {
  const rows = await many<{ enum_name: string; enum_label: string }>(
    db,
    `
      SELECT t.typname AS enum_name, e.enumlabel AS enum_label
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = current_schema()
        AND t.typname = ANY($1)
      ORDER BY t.typname, e.enumsortorder
    `,
    [MANIFEST.enums],
  )

  const byEnum = new Map<string, string[]>()
  for (const row of rows) {
    const labels = byEnum.get(row.enum_name) ?? []
    labels.push(row.enum_label)
    byEnum.set(row.enum_name, labels)
  }

  const invalid: string[] = []
  for (const [name, values] of Object.entries(MANIFEST.enumValues)) {
    if (!sameStringArray(byEnum.get(name) ?? [], values)) invalid.push(name)
  }
  assertNone('Invalid workflow Postgres schema enums', invalid)
}

const checkConstraints = async (db: WorkflowPostgresConnection) => {
  const rows = await many<{
    name: string
    table_name: string
    type: string
    columns: unknown
  }>(
    db,
    `
      SELECT
        c.conname AS name,
        rel.relname AS table_name,
        c.contype AS type,
        array_remove(array_agg(att.attname ORDER BY ord.ordinality), NULL) AS columns
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
      LEFT JOIN unnest(c.conkey) WITH ORDINALITY AS ord(attnum, ordinality)
        ON true
      LEFT JOIN pg_attribute att
        ON att.attrelid = rel.oid AND att.attnum = ord.attnum
      WHERE n.nspname = current_schema()
        AND c.conname = ANY($1)
      GROUP BY c.conname, rel.relname, c.contype
    `,
    [Object.keys(MANIFEST.constraintDefinitions)],
  )

  const byName = new Map(rows.map((row) => [row.name, row]))
  const invalid: string[] = []
  for (const [name, expected] of Object.entries(
    MANIFEST.constraintDefinitions,
  )) {
    const actual = byName.get(name)
    if (
      !actual ||
      actual.table_name !== expected.table ||
      actual.type !== expected.type ||
      !sameStringArray(actual.columns, expected.columns)
    ) {
      invalid.push(name)
    }
  }
  assertNone('Invalid workflow Postgres schema constraints', invalid)
}

const checkIndexes = async (db: WorkflowPostgresConnection) => {
  const rows = await many<{
    name: string
    table_name: string
    unique: boolean
    columns: unknown
    directions: unknown
    predicate: string | null
  }>(
    db,
    `
      SELECT
        idx.relname AS name,
        tbl.relname AS table_name,
        i.indisunique AS unique,
        array_remove(array_agg(att.attname ORDER BY ord.ordinality), NULL) AS columns,
        array_remove(
          array_agg(
            CASE
              WHEN (i.indoption[ord.ordinality - 1]::int & 1) = 1
                THEN 'DESC'
              ELSE 'ASC'
            END
            ORDER BY ord.ordinality
          ),
          NULL
        ) AS directions,
        pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_class tbl ON tbl.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = tbl.relnamespace
      LEFT JOIN unnest(i.indkey) WITH ORDINALITY AS ord(attnum, ordinality)
        ON true
      LEFT JOIN pg_attribute att
        ON att.attrelid = tbl.oid AND att.attnum = ord.attnum
      WHERE n.nspname = current_schema()
        AND idx.relname = ANY($1)
      GROUP BY idx.relname, tbl.relname, i.indisunique, i.indpred, i.indrelid
    `,
    [Object.keys(MANIFEST.indexDefinitions)],
  )

  const byName = new Map(rows.map((row) => [row.name, row]))
  const optional = new Set<string>(MANIFEST.optionalIndexes)
  const invalid: string[] = []
  for (const [name, expected] of Object.entries(MANIFEST.indexDefinitions)) {
    const actual = byName.get(name)
    // Optional indexes may be absent, but when present must match.
    if (!actual && optional.has(name)) continue
    const directions =
      'directions' in expected
        ? expected.directions
        : expected.columns.map(() => 'ASC')
    const predicate = normalizeIndexPredicate(
      'predicate' in expected ? expected.predicate : undefined,
    )
    if (
      !actual ||
      actual.table_name !== expected.table ||
      actual.unique !== expected.unique ||
      !sameStringArray(actual.columns, expected.columns) ||
      !sameStringArray(actual.directions, directions) ||
      normalizeIndexPredicate(actual.predicate) !== predicate
    ) {
      invalid.push(name)
    }
  }
  assertNone('Invalid workflow Postgres schema indexes', invalid)
}

const checkColumns = async (db: WorkflowPostgresConnection) => {
  const rows = await many<{
    table_name: string
    column_name: string
    udt_name: string
    is_nullable: string
  }>(
    db,
    `
      SELECT table_name, column_name, udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY($1)
    `,
    [MANIFEST.tables],
  )

  const byKey = new Map(
    rows.map((row) => [`${row.table_name}.${row.column_name}`, row]),
  )
  const invalid: string[] = []
  for (const [table, expected] of Object.entries(MANIFEST.columns)) {
    for (const [name, column] of Object.entries(expected)) {
      const key = `${table}.${name}`
      const actual = byKey.get(key)
      if (
        !actual ||
        actual.udt_name !== column.type ||
        (actual.is_nullable === 'YES') !== column.nullable
      ) {
        invalid.push(key)
      }
    }
  }
  assertNone('Invalid workflow Postgres schema columns', invalid)
}

export async function verifyPostgresWorkflowSchema(
  db: WorkflowPostgresConnection,
) {
  await checkObjects(db)
  await checkVersion(db)
  await checkEnums(db)
  await checkConstraints(db)
  await checkIndexes(db)
  await checkColumns(db)
}
