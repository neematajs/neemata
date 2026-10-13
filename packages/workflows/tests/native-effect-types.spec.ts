import type { WorkflowEngine } from 'effect/workflow'
import { NodeCrypto } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import { describe, expectTypeOf, it } from 'vitest'

import { defineWorkflow, step } from '../src/native-effect/index.ts'
import { defineNativeWorkflowsWorker } from '../src/native-effect/neem.ts'
import { layerCatalog } from '../src/native-effect/sql.ts'
import {
  Codec,
  StampedOnRead,
  StampedOnWrite,
} from './support/native-effect.ts'

type Engine = WorkflowEngine.WorkflowEngine
type Instance = WorkflowEngine.WorkflowInstance

const Plain = defineWorkflow('types.plain', {
  payload: { id: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ id }) => id,
})
// Its result and its failure are read back through `Codec`.
const Sealed = defineWorkflow('types.sealed', {
  payload: { id: Schema.String },
  success: StampedOnRead,
  error: StampedOnRead,
  idempotencyKey: ({ id }) => id,
})
const PlainLive = Plain.toLayer(({ id }) => Effect.succeed(id))
const codec = Layer.succeed(Codec, { prefix: 'sealed:' })
// Never built: the worker definitions below are only type-checked.
const database = Layer.mergeAll(
  PgClient.layer({ url: Redacted.make('postgres://unused') }),
  NodeCrypto.layer,
)

describe('native Effect schema services', () => {
  it('requires what a step writes and reads its result and failure with', () => {
    const written = step({
      name: 'written',
      success: StampedOnWrite,
      execute: Effect.succeed('receipt'),
    })
    const refused = step({
      name: 'refused',
      error: StampedOnWrite,
      execute: Effect.fail('declined'),
    })
    const read = step({
      name: 'read',
      success: StampedOnRead,
      error: StampedOnRead,
      execute: Effect.succeed('receipt'),
    })
    const plain = step({ name: 'plain', execute: Effect.void })

    type Durable = Engine | Instance
    expectTypeOf<Effect.Services<typeof written>>().toEqualTypeOf<
      Codec | Durable
    >()
    expectTypeOf<Effect.Services<typeof refused>>().toEqualTypeOf<
      Codec | Durable
    >()
    expectTypeOf<Effect.Services<typeof read>>().toEqualTypeOf<
      Codec | Durable
    >()
    expectTypeOf<Effect.Services<typeof plain>>().toEqualTypeOf<Durable>()

    // @ts-expect-error the step stores its result with `Codec`
    const unprovided: Effect.Effect<string, never, Durable> = written
    void unprovided
  })

  it('requires what a handler made of such a step needs', () => {
    const handlers = Plain.toLayer(() =>
      step({
        name: 'written',
        success: StampedOnWrite,
        execute: Effect.succeed('receipt'),
      }),
    )

    expectTypeOf<Layer.Services<typeof handlers>>().toEqualTypeOf<
      Codec | Engine
    >()
  })

  it('requires what the catalogued definitions decode their results with', () => {
    const plain = layerCatalog([Plain])
    const mixed = layerCatalog([Plain, Sealed])

    expectTypeOf<Layer.Services<typeof plain>>().toEqualTypeOf<Engine>()
    expectTypeOf<Layer.Services<typeof mixed>>().toEqualTypeOf<Codec | Engine>()
  })

  it('requires the Neem worker layer to provide what its definitions need', () => {
    defineNativeWorkflowsWorker({
      definitions: [Plain, Sealed],
      handlers: () => PlainLive,
      layer: () => Layer.mergeAll(database, codec),
    })
    defineNativeWorkflowsWorker({
      definitions: [Plain],
      handlers: () => PlainLive,
      layer: () => database,
    })

    defineNativeWorkflowsWorker({
      // @ts-expect-error `Sealed` decodes its result with `Codec`, which the
      // layer below does not provide
      definitions: [Plain, Sealed],
      handlers: () => PlainLive,
      layer: () => database,
    })
  })
})
