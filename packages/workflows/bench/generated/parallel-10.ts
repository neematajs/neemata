import { t } from '@nmtjs/type'

import {
  defineTask,
  defineWorkflow,
  implementWorkflow,
} from '../../src/index.ts'

const inputSchema = t.object({ seed: t.string() })
const textSchema = t.object({ text: t.string() })

export const workflow = defineWorkflow({
  name: 'bench-parallel-10',
  input: inputSchema,
  output: t.object({ text: t.string() }),
})
  .parallel('parts', ({ activity }) => ({
    part001: activity({
      input: textSchema,
      output: textSchema,
    }),
    part002: activity({
      input: textSchema,
      output: textSchema,
    }),
    part003: activity({
      input: textSchema,
      output: textSchema,
    }),
    part004: activity({
      input: textSchema,
      output: textSchema,
    }),
    part005: activity({
      input: textSchema,
      output: textSchema,
    }),
    part006: activity({
      input: textSchema,
      output: textSchema,
    }),
    part007: activity({
      input: textSchema,
      output: textSchema,
    }),
    part008: activity({
      input: textSchema,
      output: textSchema,
    }),
    part009: activity({
      input: textSchema,
      output: textSchema,
    }),
    part010: activity({
      input: textSchema,
      output: textSchema,
    }),
  }))
  .build()

export const implementation = implementWorkflow(workflow)
  .parts(({ activity }) => ({
    part001: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part002: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part003: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part004: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part005: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part006: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part007: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part008: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part009: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part010: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
  }))
  .finish((_ctx, { parts }) => ({ text: parts.part001.text }))
