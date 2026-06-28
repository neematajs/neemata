import { t } from '@nmtjs/type'

import {
  defineTask,
  defineWorkflow,
  implementWorkflow,
} from '../../src/index.ts'

const inputSchema = t.object({ seed: t.string() })
const textSchema = t.object({ text: t.string() })

export const workflow = defineWorkflow({
  name: 'bench-branch-10',
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
    }),
  })
  .finish((_ctx, { choice }) => ({ text: choice.text }))
