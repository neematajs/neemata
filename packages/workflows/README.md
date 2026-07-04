# @nmtjs/workflows

Typed workflow and task primitives for Neemata.

## Imports

Declaration and implementation APIs stay dependency-light:

```ts
import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '@nmtjs/workflows'
```

Postgres runtime code lives behind explicit subpaths:

```ts
import { createWorkflowRuntimeClient } from '@nmtjs/workflows/runtime'
import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  verifyPostgresWorkflowSchema,
} from '@nmtjs/workflows/postgres'
import { createSchema } from '@nmtjs/workflows/postgres/drizzle'
```

## Runtime Connection

Runtime code consumes a small `WorkflowPostgresConnection` interface. For
`pg`-style clients and pools, wrap the app-owned client:

```ts
import { Pool } from 'pg'
import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  verifyPostgresWorkflowSchema,
} from '@nmtjs/workflows/postgres'

const connection = createPostgresWorkflowConnection(
  new Pool({ connectionString }),
)

await verifyPostgresWorkflowSchema(connection)

const runtime = createPostgresWorkflowRuntime({ connection })
```

Other clients can pass a custom object that satisfies `WorkflowPostgresConnection`.

## Postgres Schema

Applications own production migrations. The package exports Drizzle schema
objects so apps can include them in their own migration flow:

```ts
const workflows = createSchema()

export const WorkflowRunTable = workflows.tables.runs
export const WorkflowNodeTable = workflows.tables.nodes
export const WorkflowRunKind = workflows.enums.runKind
```

`createSchema()` emits the canonical physical table and enum names required by
the runtime. Custom database object names are not supported yet.

Your migration must also seed the schema version row used by startup
verification:

```sql
INSERT INTO workflow_schema_version (id, version)
VALUES (1, 1)
ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version;
```

Use `verifyPostgresWorkflowSchema(connection)` at startup to fail fast when the
installed schema does not match the runtime. The helper
`installPostgresWorkflowSchemaForTesting(connection)` is available from
`@nmtjs/workflows/postgres/testing` for tests and local development only, not
production migrations.
