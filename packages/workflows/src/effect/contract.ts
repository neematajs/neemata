import type { EffectSchemaKind } from './codec.ts'
import { createContract } from '../contract/index.ts'
import { toCodec } from './codec.ts'

/** The definition builders, declared with Effect or Standard schemas. */
export const { defineTask, defineWorkflow } =
  createContract<EffectSchemaKind>(toCodec)
