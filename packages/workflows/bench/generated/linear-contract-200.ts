import { t } from '@nmtjs/type'

import {
  defineTask,
  defineWorkflow,
  implementWorkflow,
} from '../../src/index.ts'

const inputSchema = t.object({ seed: t.string() })
const textSchema = t.object({ text: t.string() })

export const workflow = defineWorkflow({
  name: 'bench-linear-contract-200',
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

  .activity('step096', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step097', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step098', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step099', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step100', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step101', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step102', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step103', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step104', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step105', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step106', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step107', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step108', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step109', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step110', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step111', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step112', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step113', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step114', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step115', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step116', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step117', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step118', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step119', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step120', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step121', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step122', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step123', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step124', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step125', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step126', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step127', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step128', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step129', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step130', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step131', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step132', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step133', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step134', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step135', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step136', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step137', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step138', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step139', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step140', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step141', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step142', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step143', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step144', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step145', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step146', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step147', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step148', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step149', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step150', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step151', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step152', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step153', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step154', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step155', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step156', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step157', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step158', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step159', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step160', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step161', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step162', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step163', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step164', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step165', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step166', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step167', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step168', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step169', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step170', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step171', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step172', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step173', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step174', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step175', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step176', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step177', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step178', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step179', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step180', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step181', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step182', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step183', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step184', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step185', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step186', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step187', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step188', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step189', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step190', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step191', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step192', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step193', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step194', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step195', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step196', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step197', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step198', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step199', {
    input: textSchema,
    output: textSchema,
  })

  .activity('step200', {
    input: textSchema,
    output: textSchema,
  })
  .build()
