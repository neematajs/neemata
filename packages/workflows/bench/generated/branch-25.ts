import { t } from '@nmtjs/type'

import {
  defineTask,
  defineWorkflow,
  implementWorkflow,
} from '../../src/index.ts'

const inputSchema = t.object({ seed: t.string() })
const textSchema = t.object({ text: t.string() })

export const workflow = defineWorkflow({
  name: 'bench-branch-25',
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
    }),
  })
  .finish((_ctx, { choice }) => ({ text: choice.text }))
