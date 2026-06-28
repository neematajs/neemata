import { t } from '@nmtjs/type'

import {
  defineTask,
  defineWorkflow,
  implementWorkflow,
} from '../../src/index.ts'

const inputSchema = t.object({ seed: t.string() })
const textSchema = t.object({ text: t.string() })

export const workflow = defineWorkflow({
  name: 'bench-branch-50',
  input: inputSchema,
  output: t.object({ text: t.string() }),
})
  .branch('choice', {
    cases: ({ activity }) => ({
      case001: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case001'), text: t.string() }),
      }),
      case002: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case002'), text: t.string() }),
      }),
      case003: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case003'), text: t.string() }),
      }),
      case004: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case004'), text: t.string() }),
      }),
      case005: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case005'), text: t.string() }),
      }),
      case006: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case006'), text: t.string() }),
      }),
      case007: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case007'), text: t.string() }),
      }),
      case008: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case008'), text: t.string() }),
      }),
      case009: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case009'), text: t.string() }),
      }),
      case010: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case010'), text: t.string() }),
      }),
      case011: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case011'), text: t.string() }),
      }),
      case012: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case012'), text: t.string() }),
      }),
      case013: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case013'), text: t.string() }),
      }),
      case014: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case014'), text: t.string() }),
      }),
      case015: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case015'), text: t.string() }),
      }),
      case016: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case016'), text: t.string() }),
      }),
      case017: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case017'), text: t.string() }),
      }),
      case018: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case018'), text: t.string() }),
      }),
      case019: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case019'), text: t.string() }),
      }),
      case020: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case020'), text: t.string() }),
      }),
      case021: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case021'), text: t.string() }),
      }),
      case022: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case022'), text: t.string() }),
      }),
      case023: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case023'), text: t.string() }),
      }),
      case024: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case024'), text: t.string() }),
      }),
      case025: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case025'), text: t.string() }),
      }),
      case026: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case026'), text: t.string() }),
      }),
      case027: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case027'), text: t.string() }),
      }),
      case028: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case028'), text: t.string() }),
      }),
      case029: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case029'), text: t.string() }),
      }),
      case030: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case030'), text: t.string() }),
      }),
      case031: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case031'), text: t.string() }),
      }),
      case032: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case032'), text: t.string() }),
      }),
      case033: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case033'), text: t.string() }),
      }),
      case034: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case034'), text: t.string() }),
      }),
      case035: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case035'), text: t.string() }),
      }),
      case036: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case036'), text: t.string() }),
      }),
      case037: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case037'), text: t.string() }),
      }),
      case038: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case038'), text: t.string() }),
      }),
      case039: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case039'), text: t.string() }),
      }),
      case040: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case040'), text: t.string() }),
      }),
      case041: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case041'), text: t.string() }),
      }),
      case042: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case042'), text: t.string() }),
      }),
      case043: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case043'), text: t.string() }),
      }),
      case044: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case044'), text: t.string() }),
      }),
      case045: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case045'), text: t.string() }),
      }),
      case046: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case046'), text: t.string() }),
      }),
      case047: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case047'), text: t.string() }),
      }),
      case048: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case048'), text: t.string() }),
      }),
      case049: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case049'), text: t.string() }),
      }),
      case050: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case050'), text: t.string() }),
      }),
    }),
  })
  .build()

export const implementation = implementWorkflow(workflow)
  .choice({
    select: (
      _ctx,
      _outputs,
      _input,
    ): keyof (typeof workflow.nodes)[0]['cases'] => 'case001',
    cases: ({ activity }) => ({
      case001: activity(
        async (_ctx, input) => ({ kind: 'case001' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case002: activity(
        async (_ctx, input) => ({ kind: 'case002' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case003: activity(
        async (_ctx, input) => ({ kind: 'case003' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case004: activity(
        async (_ctx, input) => ({ kind: 'case004' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case005: activity(
        async (_ctx, input) => ({ kind: 'case005' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case006: activity(
        async (_ctx, input) => ({ kind: 'case006' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case007: activity(
        async (_ctx, input) => ({ kind: 'case007' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case008: activity(
        async (_ctx, input) => ({ kind: 'case008' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case009: activity(
        async (_ctx, input) => ({ kind: 'case009' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case010: activity(
        async (_ctx, input) => ({ kind: 'case010' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case011: activity(
        async (_ctx, input) => ({ kind: 'case011' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case012: activity(
        async (_ctx, input) => ({ kind: 'case012' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case013: activity(
        async (_ctx, input) => ({ kind: 'case013' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case014: activity(
        async (_ctx, input) => ({ kind: 'case014' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case015: activity(
        async (_ctx, input) => ({ kind: 'case015' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case016: activity(
        async (_ctx, input) => ({ kind: 'case016' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case017: activity(
        async (_ctx, input) => ({ kind: 'case017' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case018: activity(
        async (_ctx, input) => ({ kind: 'case018' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case019: activity(
        async (_ctx, input) => ({ kind: 'case019' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case020: activity(
        async (_ctx, input) => ({ kind: 'case020' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case021: activity(
        async (_ctx, input) => ({ kind: 'case021' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case022: activity(
        async (_ctx, input) => ({ kind: 'case022' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case023: activity(
        async (_ctx, input) => ({ kind: 'case023' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case024: activity(
        async (_ctx, input) => ({ kind: 'case024' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case025: activity(
        async (_ctx, input) => ({ kind: 'case025' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case026: activity(
        async (_ctx, input) => ({ kind: 'case026' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case027: activity(
        async (_ctx, input) => ({ kind: 'case027' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case028: activity(
        async (_ctx, input) => ({ kind: 'case028' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case029: activity(
        async (_ctx, input) => ({ kind: 'case029' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case030: activity(
        async (_ctx, input) => ({ kind: 'case030' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case031: activity(
        async (_ctx, input) => ({ kind: 'case031' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case032: activity(
        async (_ctx, input) => ({ kind: 'case032' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case033: activity(
        async (_ctx, input) => ({ kind: 'case033' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case034: activity(
        async (_ctx, input) => ({ kind: 'case034' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case035: activity(
        async (_ctx, input) => ({ kind: 'case035' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case036: activity(
        async (_ctx, input) => ({ kind: 'case036' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case037: activity(
        async (_ctx, input) => ({ kind: 'case037' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case038: activity(
        async (_ctx, input) => ({ kind: 'case038' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case039: activity(
        async (_ctx, input) => ({ kind: 'case039' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case040: activity(
        async (_ctx, input) => ({ kind: 'case040' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case041: activity(
        async (_ctx, input) => ({ kind: 'case041' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case042: activity(
        async (_ctx, input) => ({ kind: 'case042' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case043: activity(
        async (_ctx, input) => ({ kind: 'case043' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case044: activity(
        async (_ctx, input) => ({ kind: 'case044' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case045: activity(
        async (_ctx, input) => ({ kind: 'case045' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case046: activity(
        async (_ctx, input) => ({ kind: 'case046' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case047: activity(
        async (_ctx, input) => ({ kind: 'case047' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case048: activity(
        async (_ctx, input) => ({ kind: 'case048' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case049: activity(
        async (_ctx, input) => ({ kind: 'case049' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case050: activity(
        async (_ctx, input) => ({ kind: 'case050' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
    }),
  })
  .finish((_ctx, { choice }) => ({ text: choice.text }))
