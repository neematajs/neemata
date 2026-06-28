import { t } from '@nmtjs/type'

import {
  defineTask,
  defineWorkflow,
  implementWorkflow,
} from '../../src/index.ts'

const inputSchema = t.object({ seed: t.string() })
const textSchema = t.object({ text: t.string() })

export const workflow = defineWorkflow({
  name: 'bench-branch-100',
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
      case051: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case051'), text: t.string() }),
      }),
      case052: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case052'), text: t.string() }),
      }),
      case053: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case053'), text: t.string() }),
      }),
      case054: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case054'), text: t.string() }),
      }),
      case055: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case055'), text: t.string() }),
      }),
      case056: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case056'), text: t.string() }),
      }),
      case057: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case057'), text: t.string() }),
      }),
      case058: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case058'), text: t.string() }),
      }),
      case059: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case059'), text: t.string() }),
      }),
      case060: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case060'), text: t.string() }),
      }),
      case061: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case061'), text: t.string() }),
      }),
      case062: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case062'), text: t.string() }),
      }),
      case063: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case063'), text: t.string() }),
      }),
      case064: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case064'), text: t.string() }),
      }),
      case065: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case065'), text: t.string() }),
      }),
      case066: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case066'), text: t.string() }),
      }),
      case067: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case067'), text: t.string() }),
      }),
      case068: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case068'), text: t.string() }),
      }),
      case069: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case069'), text: t.string() }),
      }),
      case070: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case070'), text: t.string() }),
      }),
      case071: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case071'), text: t.string() }),
      }),
      case072: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case072'), text: t.string() }),
      }),
      case073: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case073'), text: t.string() }),
      }),
      case074: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case074'), text: t.string() }),
      }),
      case075: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case075'), text: t.string() }),
      }),
      case076: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case076'), text: t.string() }),
      }),
      case077: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case077'), text: t.string() }),
      }),
      case078: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case078'), text: t.string() }),
      }),
      case079: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case079'), text: t.string() }),
      }),
      case080: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case080'), text: t.string() }),
      }),
      case081: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case081'), text: t.string() }),
      }),
      case082: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case082'), text: t.string() }),
      }),
      case083: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case083'), text: t.string() }),
      }),
      case084: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case084'), text: t.string() }),
      }),
      case085: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case085'), text: t.string() }),
      }),
      case086: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case086'), text: t.string() }),
      }),
      case087: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case087'), text: t.string() }),
      }),
      case088: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case088'), text: t.string() }),
      }),
      case089: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case089'), text: t.string() }),
      }),
      case090: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case090'), text: t.string() }),
      }),
      case091: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case091'), text: t.string() }),
      }),
      case092: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case092'), text: t.string() }),
      }),
      case093: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case093'), text: t.string() }),
      }),
      case094: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case094'), text: t.string() }),
      }),
      case095: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case095'), text: t.string() }),
      }),
      case096: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case096'), text: t.string() }),
      }),
      case097: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case097'), text: t.string() }),
      }),
      case098: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case098'), text: t.string() }),
      }),
      case099: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case099'), text: t.string() }),
      }),
      case100: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('case100'), text: t.string() }),
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
      case051: activity(
        async (_ctx, input) => ({ kind: 'case051' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case052: activity(
        async (_ctx, input) => ({ kind: 'case052' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case053: activity(
        async (_ctx, input) => ({ kind: 'case053' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case054: activity(
        async (_ctx, input) => ({ kind: 'case054' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case055: activity(
        async (_ctx, input) => ({ kind: 'case055' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case056: activity(
        async (_ctx, input) => ({ kind: 'case056' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case057: activity(
        async (_ctx, input) => ({ kind: 'case057' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case058: activity(
        async (_ctx, input) => ({ kind: 'case058' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case059: activity(
        async (_ctx, input) => ({ kind: 'case059' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case060: activity(
        async (_ctx, input) => ({ kind: 'case060' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case061: activity(
        async (_ctx, input) => ({ kind: 'case061' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case062: activity(
        async (_ctx, input) => ({ kind: 'case062' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case063: activity(
        async (_ctx, input) => ({ kind: 'case063' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case064: activity(
        async (_ctx, input) => ({ kind: 'case064' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case065: activity(
        async (_ctx, input) => ({ kind: 'case065' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case066: activity(
        async (_ctx, input) => ({ kind: 'case066' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case067: activity(
        async (_ctx, input) => ({ kind: 'case067' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case068: activity(
        async (_ctx, input) => ({ kind: 'case068' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case069: activity(
        async (_ctx, input) => ({ kind: 'case069' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case070: activity(
        async (_ctx, input) => ({ kind: 'case070' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case071: activity(
        async (_ctx, input) => ({ kind: 'case071' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case072: activity(
        async (_ctx, input) => ({ kind: 'case072' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case073: activity(
        async (_ctx, input) => ({ kind: 'case073' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case074: activity(
        async (_ctx, input) => ({ kind: 'case074' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case075: activity(
        async (_ctx, input) => ({ kind: 'case075' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case076: activity(
        async (_ctx, input) => ({ kind: 'case076' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case077: activity(
        async (_ctx, input) => ({ kind: 'case077' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case078: activity(
        async (_ctx, input) => ({ kind: 'case078' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case079: activity(
        async (_ctx, input) => ({ kind: 'case079' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case080: activity(
        async (_ctx, input) => ({ kind: 'case080' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case081: activity(
        async (_ctx, input) => ({ kind: 'case081' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case082: activity(
        async (_ctx, input) => ({ kind: 'case082' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case083: activity(
        async (_ctx, input) => ({ kind: 'case083' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case084: activity(
        async (_ctx, input) => ({ kind: 'case084' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case085: activity(
        async (_ctx, input) => ({ kind: 'case085' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case086: activity(
        async (_ctx, input) => ({ kind: 'case086' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case087: activity(
        async (_ctx, input) => ({ kind: 'case087' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case088: activity(
        async (_ctx, input) => ({ kind: 'case088' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case089: activity(
        async (_ctx, input) => ({ kind: 'case089' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case090: activity(
        async (_ctx, input) => ({ kind: 'case090' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case091: activity(
        async (_ctx, input) => ({ kind: 'case091' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case092: activity(
        async (_ctx, input) => ({ kind: 'case092' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case093: activity(
        async (_ctx, input) => ({ kind: 'case093' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case094: activity(
        async (_ctx, input) => ({ kind: 'case094' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case095: activity(
        async (_ctx, input) => ({ kind: 'case095' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case096: activity(
        async (_ctx, input) => ({ kind: 'case096' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case097: activity(
        async (_ctx, input) => ({ kind: 'case097' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case098: activity(
        async (_ctx, input) => ({ kind: 'case098' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case099: activity(
        async (_ctx, input) => ({ kind: 'case099' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
      case100: activity(
        async (_ctx, input) => ({ kind: 'case100' as const, text: input.text }),
        { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
      ),
    }),
  })
  .finish((_ctx, { choice }) => ({ text: choice.text }))
