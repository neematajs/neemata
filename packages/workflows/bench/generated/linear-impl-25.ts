import { t } from '@nmtjs/type'

import {
  defineTask,
  defineWorkflow,
  implementWorkflow,
} from '../../src/index.ts'

const inputSchema = t.object({ seed: t.string() })
const textSchema = t.object({ text: t.string() })

export const workflow = defineWorkflow({
  name: 'bench-linear-contract-25',
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
  .finish((_ctx, { step025 }) => ({ text: step025.text }))
