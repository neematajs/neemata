import type * as JsonSchema from 'effect/JsonSchema'
import * as Context from 'effect/Context'
import * as Schema from 'effect/Schema'

import type { Kind } from './definition.ts'
import { callField, DefinitionKind, Pool } from './definition.ts'

type Described = {
  readonly _tag: string
  readonly annotations: Context.Context<never>
  readonly payloadSchema: Schema.Struct<Schema.Struct.Fields>
  readonly successSchema: Schema.Top
  readonly errorSchema: Schema.Top
}

type Document = JsonSchema.Document<'draft-2020-12'>

export type Description = {
  readonly name: string
  readonly kind: Kind
  readonly pool: string
  readonly payload: Document
  readonly success: Document
  readonly error: Document
}

/**
 * The static shape of a definition, for tooling. A native workflow is a
 * program rather than a graph, so there are no nodes or edges to describe.
 */
export function describe(definition: Described): Description {
  const { _tag: name, annotations } = definition
  // The call key is engine plumbing, not part of what a caller sends.
  const { [callField]: _call, ...fields } = definition.payloadSchema.fields

  const kind = Context.get(annotations, DefinitionKind)
  const pool = Context.get(annotations, Pool)
  const payload = Schema.toJsonSchemaDocument(Schema.Struct(fields))
  const success = Schema.toJsonSchemaDocument(definition.successSchema)
  const error = Schema.toJsonSchemaDocument(definition.errorSchema)

  return { name, kind, pool, payload, success, error }
}
