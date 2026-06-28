import { t } from '@nmtjs/type'

import {
  defineTask,
  defineWorkflow,
  implementWorkflow,
} from '../../src/index.ts'

const inputSchema = t.object({ seed: t.string() })
const textSchema = t.object({ text: t.string() })

export const workflow = defineWorkflow({
  name: 'bench-linear-contract-50',
  input: inputSchema,
  output: textSchema,
})
  .activity('step001', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step002', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step003', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step004', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step005', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step006', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step007', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step008', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step009', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step010', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step011', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step012', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step013', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step014', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step015', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step016', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step017', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step018', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step019', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step020', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step021', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step022', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step023', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step024', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step025', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step026', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step027', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step028', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step029', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step030', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step031', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step032', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step033', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step034', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step035', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step036', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step037', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step038', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step039', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step040', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step041', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step042', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step043', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step044', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step045', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step046', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step047', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step048', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step049', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step050', {
    input: textSchema,
    output: textSchema,
  })
  .build()

export const implementation = implementWorkflow(workflow)
  .step001(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, _outputs, input) => ({ text: input.seed }),
  })

  .step002(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step001 }) => ({ text: step001.text }),
  })

  .step003(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step002 }) => ({ text: step002.text }),
  })

  .step004(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step003 }) => ({ text: step003.text }),
  })

  .step005(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step004 }) => ({ text: step004.text }),
  })

  .step006(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step005 }) => ({ text: step005.text }),
  })

  .step007(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step006 }) => ({ text: step006.text }),
  })

  .step008(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step007 }) => ({ text: step007.text }),
  })

  .step009(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step008 }) => ({ text: step008.text }),
  })

  .step010(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step009 }) => ({ text: step009.text }),
  })

  .step011(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step010 }) => ({ text: step010.text }),
  })

  .step012(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step011 }) => ({ text: step011.text }),
  })

  .step013(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step012 }) => ({ text: step012.text }),
  })

  .step014(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step013 }) => ({ text: step013.text }),
  })

  .step015(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step014 }) => ({ text: step014.text }),
  })

  .step016(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step015 }) => ({ text: step015.text }),
  })

  .step017(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step016 }) => ({ text: step016.text }),
  })

  .step018(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step017 }) => ({ text: step017.text }),
  })

  .step019(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step018 }) => ({ text: step018.text }),
  })

  .step020(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step019 }) => ({ text: step019.text }),
  })

  .step021(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step020 }) => ({ text: step020.text }),
  })

  .step022(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step021 }) => ({ text: step021.text }),
  })

  .step023(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step022 }) => ({ text: step022.text }),
  })

  .step024(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step023 }) => ({ text: step023.text }),
  })

  .step025(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step024 }) => ({ text: step024.text }),
  })

  .step026(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step025 }) => ({ text: step025.text }),
  })

  .step027(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step026 }) => ({ text: step026.text }),
  })

  .step028(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step027 }) => ({ text: step027.text }),
  })

  .step029(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step028 }) => ({ text: step028.text }),
  })

  .step030(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step029 }) => ({ text: step029.text }),
  })

  .step031(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step030 }) => ({ text: step030.text }),
  })

  .step032(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step031 }) => ({ text: step031.text }),
  })

  .step033(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step032 }) => ({ text: step032.text }),
  })

  .step034(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step033 }) => ({ text: step033.text }),
  })

  .step035(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step034 }) => ({ text: step034.text }),
  })

  .step036(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step035 }) => ({ text: step035.text }),
  })

  .step037(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step036 }) => ({ text: step036.text }),
  })

  .step038(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step037 }) => ({ text: step037.text }),
  })

  .step039(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step038 }) => ({ text: step038.text }),
  })

  .step040(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step039 }) => ({ text: step039.text }),
  })

  .step041(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step040 }) => ({ text: step040.text }),
  })

  .step042(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step041 }) => ({ text: step041.text }),
  })

  .step043(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step042 }) => ({ text: step042.text }),
  })

  .step044(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step043 }) => ({ text: step043.text }),
  })

  .step045(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step044 }) => ({ text: step044.text }),
  })

  .step046(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step045 }) => ({ text: step045.text }),
  })

  .step047(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step046 }) => ({ text: step046.text }),
  })

  .step048(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step047 }) => ({ text: step047.text }),
  })

  .step049(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step048 }) => ({ text: step048.text }),
  })

  .step050(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step049 }) => ({ text: step049.text }),
  })
  .finish((_ctx, { step050 }) => ({ text: step050.text }))
