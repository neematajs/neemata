import { t } from '@nmtjs/type'

import {
  defineTask,
  defineWorkflow,
  implementWorkflow,
} from '../../src/index.ts'

const inputSchema = t.object({ seed: t.string() })
const textSchema = t.object({ text: t.string() })

export const workflow = defineWorkflow({
  name: 'bench-linear-contract-10',
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
  .finish((_ctx, { step010 }) => ({ text: step010.text }))
