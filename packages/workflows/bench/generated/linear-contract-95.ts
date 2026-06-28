import { t } from '@nmtjs/type'

import {
  defineTask,
  defineWorkflow,
  implementWorkflow,
} from '../../src/index.ts'

const inputSchema = t.object({ seed: t.string() })
const textSchema = t.object({ text: t.string() })

export const workflow = defineWorkflow({
  name: 'bench-linear-contract-95',
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

  .activity('step051', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step052', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step053', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step054', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step055', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step056', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step057', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step058', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step059', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step060', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step061', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step062', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step063', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step064', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step065', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step066', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step067', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step068', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step069', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step070', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step071', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step072', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step073', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step074', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step075', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step076', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step077', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step078', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step079', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step080', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step081', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step082', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step083', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step084', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step085', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step086', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step087', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step088', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step089', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step090', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step091', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step092', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step093', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step094', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step095', {
    input: textSchema,
    output: textSchema,
  })
  .build()
