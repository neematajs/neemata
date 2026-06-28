import { t } from '@nmtjs/type'

import {
  defineTask,
  defineWorkflow,
  implementWorkflow,
} from '../../src/index.ts'

const inputSchema = t.object({ seed: t.string() })
const textSchema = t.object({ text: t.string() })

export const workflow = defineWorkflow({
  name: 'bench-parallel-100',
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
    part051: activity({
      input: textSchema,
      output: textSchema,
    }),
    part052: activity({
      input: textSchema,
      output: textSchema,
    }),
    part053: activity({
      input: textSchema,
      output: textSchema,
    }),
    part054: activity({
      input: textSchema,
      output: textSchema,
    }),
    part055: activity({
      input: textSchema,
      output: textSchema,
    }),
    part056: activity({
      input: textSchema,
      output: textSchema,
    }),
    part057: activity({
      input: textSchema,
      output: textSchema,
    }),
    part058: activity({
      input: textSchema,
      output: textSchema,
    }),
    part059: activity({
      input: textSchema,
      output: textSchema,
    }),
    part060: activity({
      input: textSchema,
      output: textSchema,
    }),
    part061: activity({
      input: textSchema,
      output: textSchema,
    }),
    part062: activity({
      input: textSchema,
      output: textSchema,
    }),
    part063: activity({
      input: textSchema,
      output: textSchema,
    }),
    part064: activity({
      input: textSchema,
      output: textSchema,
    }),
    part065: activity({
      input: textSchema,
      output: textSchema,
    }),
    part066: activity({
      input: textSchema,
      output: textSchema,
    }),
    part067: activity({
      input: textSchema,
      output: textSchema,
    }),
    part068: activity({
      input: textSchema,
      output: textSchema,
    }),
    part069: activity({
      input: textSchema,
      output: textSchema,
    }),
    part070: activity({
      input: textSchema,
      output: textSchema,
    }),
    part071: activity({
      input: textSchema,
      output: textSchema,
    }),
    part072: activity({
      input: textSchema,
      output: textSchema,
    }),
    part073: activity({
      input: textSchema,
      output: textSchema,
    }),
    part074: activity({
      input: textSchema,
      output: textSchema,
    }),
    part075: activity({
      input: textSchema,
      output: textSchema,
    }),
    part076: activity({
      input: textSchema,
      output: textSchema,
    }),
    part077: activity({
      input: textSchema,
      output: textSchema,
    }),
    part078: activity({
      input: textSchema,
      output: textSchema,
    }),
    part079: activity({
      input: textSchema,
      output: textSchema,
    }),
    part080: activity({
      input: textSchema,
      output: textSchema,
    }),
    part081: activity({
      input: textSchema,
      output: textSchema,
    }),
    part082: activity({
      input: textSchema,
      output: textSchema,
    }),
    part083: activity({
      input: textSchema,
      output: textSchema,
    }),
    part084: activity({
      input: textSchema,
      output: textSchema,
    }),
    part085: activity({
      input: textSchema,
      output: textSchema,
    }),
    part086: activity({
      input: textSchema,
      output: textSchema,
    }),
    part087: activity({
      input: textSchema,
      output: textSchema,
    }),
    part088: activity({
      input: textSchema,
      output: textSchema,
    }),
    part089: activity({
      input: textSchema,
      output: textSchema,
    }),
    part090: activity({
      input: textSchema,
      output: textSchema,
    }),
    part091: activity({
      input: textSchema,
      output: textSchema,
    }),
    part092: activity({
      input: textSchema,
      output: textSchema,
    }),
    part093: activity({
      input: textSchema,
      output: textSchema,
    }),
    part094: activity({
      input: textSchema,
      output: textSchema,
    }),
    part095: activity({
      input: textSchema,
      output: textSchema,
    }),
    part096: activity({
      input: textSchema,
      output: textSchema,
    }),
    part097: activity({
      input: textSchema,
      output: textSchema,
    }),
    part098: activity({
      input: textSchema,
      output: textSchema,
    }),
    part099: activity({
      input: textSchema,
      output: textSchema,
    }),
    part100: activity({
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
    part051: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part052: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part053: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part054: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part055: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part056: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part057: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part058: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part059: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part060: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part061: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part062: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part063: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part064: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part065: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part066: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part067: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part068: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part069: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part070: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part071: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part072: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part073: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part074: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part075: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part076: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part077: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part078: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part079: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part080: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part081: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part082: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part083: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part084: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part085: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part086: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part087: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part088: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part089: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part090: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part091: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part092: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part093: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part094: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part095: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part096: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part097: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part098: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part099: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
    part100: activity(async (_ctx, input) => ({ text: input.text }), {
      input: (_ctx, _outputs, input) => ({ text: input.seed }),
    }),
  }))
  .finish((_ctx, { parts }) => ({ text: parts.part001.text }))
