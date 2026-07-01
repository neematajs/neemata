# @nmtjs/workflows

Typed workflow and task primitives for Neemata.

## Imports

Declaration and implementation APIs stay dependency-light:

```ts
import { defineTask, defineWorkflow, implementTask, implementWorkflow } from '@nmtjs/workflows'
```

Postgres runtime code lives behind explicit subpaths:

```ts
import { createWorkflowRuntimeClient } from '@nmtjs/workflows/runtime'
import {
  createPostgresWorkflowRuntime,
  verifyPostgresWorkflowSchema,
} from '@nmtjs/workflows/postgres'
import { createSchema } from '@nmtjs/workflows/postgres/drizzle'
```

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

Use `verifyPostgresWorkflowSchema(connection)` at startup to fail fast when the
installed schema does not match the runtime. The helper
`installPostgresWorkflowSchemaForTesting(connection)` is for tests and local
development only, not production migrations.
