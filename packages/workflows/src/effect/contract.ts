import type { EffectSchemaKind } from './codec.ts'
import { createContract } from '../contract/index.ts'
import { codec } from './codec.ts'

/** The definition builders, declared with Effect schemas. */
export const { defineTask, defineWorkflow } =
  createContract<EffectSchemaKind>(codec)
