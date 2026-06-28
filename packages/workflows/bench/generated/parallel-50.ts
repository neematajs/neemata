import { t } from '@nmtjs/type'

import {
  defineTask,
  defineWorkflow,
  implementWorkflow,
} from '../../src/index.ts'

const inputSchema = t.object({ seed: t.string() })
const textSchema = t.object({ text: t.string() })

export const workflow = defineWorkflow({
  name: 'bench-parallel-50',
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
    part011: activity({
      input: textSchema,
      output: textSchema,
    }),
    part012: activity({
      input: textSchema,
      output: textSchema,
    }),
    part013: activity({
      input: textSchema,
      output: textSchema,
    }),
    part014: activity({
      input: textSchema,
      output: textSchema,
    }),
    part015: activity({
      input: textSchema,
      output: textSchema,
    }),
    part016: activity({
      input: textSchema,
      output: textSchema,
    }),
    part017: activity({
      input: textSchema,
      output: textSchema,
    }),
    part018: activity({
      input: textSchema,
      output: textSchema,
    }),
    part019: activity({
      input: textSchema,
      output: textSchema,
    }),
    part020: activity({
      input: textSchema,
      output: textSchema,
    }),
    part021: activity({
      input: textSchema,
      output: textSchema,
    }),
    part022: activity({
      input: textSchema,
      output: textSchema,
    }),
    part023: activity({
      input: textSchema,
      output: textSchema,
    }),
    part024: activity({
      input: textSchema,
      output: textSchema,
    }),
    part025: activity({
      input: textSchema,
      output: textSchema,
    }),
    part026: activity({
      input: textSchema,
      output: textSchema,
    }),
    part027: activity({
      input: textSchema,
      output: textSchema,
    }),
    part028: activity({
      input: textSchema,
      output: textSchema,
    }),
    part029: activity({
      input: textSchema,
      output: textSchema,
    }),
    part030: activity({
      input: textSchema,
      output: textSchema,
    }),
    part031: activity({
      input: textSchema,
      output: textSchema,
    }),
    part032: activity({
      input: textSchema,
      output: textSchema,
    }),
    part033: activity({
      input: textSchema,
      output: textSchema,
    }),
    part034: activity({
      input: textSchema,
      output: textSchema,
    }),
    part035: activity({
      input: textSchema,
      output: textSchema,
    }),
    part036: activity({
      input: textSchema,
      output: textSchema,
    }),
    part037: activity({
      input: textSchema,
      output: textSchema,
    }),
    part038: activity({
      input: textSchema,
      output: textSchema,
    }),
    part039: activity({
      input: textSchema,
      output: textSchema,
    }),
    part040: activity({
      input: textSchema,
      output: textSchema,
    }),
    part041: activity({
      input: textSchema,
      output: textSchema,
    }),
    part042: activity({
      input: textSchema,
      output: textSchema,
    }),
    part043: activity({
      input: textSchema,
      output: textSchema,
    }),
    part044: activity({
      input: textSchema,
      output: textSchema,
    }),
    part045: activity({
      input: textSchema,
      output: textSchema,
    }),
    part046: activity({
      input: textSchema,
      output: textSchema,
    }),
    part047: activity({
      input: textSchema,
      output: textSchema,
    }),
    part048: activity({
      input: textSchema,
      output: textSchema,
    }),
    part049: activity({
      input: textSchema,
      output: textSchema,
    }),
    part050: activity({
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
    part011: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part012: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part013: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part014: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part015: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part016: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part017: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part018: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part019: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part020: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part021: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part022: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part023: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part024: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part025: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part026: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part027: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part028: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part029: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part030: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part031: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part032: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part033: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part034: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part035: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part036: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part037: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part038: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part039: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part040: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part041: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part042: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part043: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part044: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part045: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part046: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part047: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part048: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part049: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part050: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
  }))
  .finish((_ctx, { parts }) => ({ text: parts.part001.text }))
