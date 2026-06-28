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
