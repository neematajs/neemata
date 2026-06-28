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

  .step051(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step050 }) => ({ text: step050.text }),
  })

  .step052(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step051 }) => ({ text: step051.text }),
  })

  .step053(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step052 }) => ({ text: step052.text }),
  })

  .step054(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step053 }) => ({ text: step053.text }),
  })

  .step055(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step054 }) => ({ text: step054.text }),
  })

  .step056(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step055 }) => ({ text: step055.text }),
  })

  .step057(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step056 }) => ({ text: step056.text }),
  })

  .step058(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step057 }) => ({ text: step057.text }),
  })

  .step059(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step058 }) => ({ text: step058.text }),
  })

  .step060(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step059 }) => ({ text: step059.text }),
  })

  .step061(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step060 }) => ({ text: step060.text }),
  })

  .step062(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step061 }) => ({ text: step061.text }),
  })

  .step063(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step062 }) => ({ text: step062.text }),
  })

  .step064(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step063 }) => ({ text: step063.text }),
  })

  .step065(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step064 }) => ({ text: step064.text }),
  })

  .step066(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step065 }) => ({ text: step065.text }),
  })

  .step067(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step066 }) => ({ text: step066.text }),
  })

  .step068(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step067 }) => ({ text: step067.text }),
  })

  .step069(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step068 }) => ({ text: step068.text }),
  })

  .step070(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step069 }) => ({ text: step069.text }),
  })

  .step071(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step070 }) => ({ text: step070.text }),
  })

  .step072(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step071 }) => ({ text: step071.text }),
  })

  .step073(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step072 }) => ({ text: step072.text }),
  })

  .step074(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step073 }) => ({ text: step073.text }),
  })

  .step075(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step074 }) => ({ text: step074.text }),
  })

  .step076(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step075 }) => ({ text: step075.text }),
  })

  .step077(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step076 }) => ({ text: step076.text }),
  })

  .step078(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step077 }) => ({ text: step077.text }),
  })

  .step079(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step078 }) => ({ text: step078.text }),
  })

  .step080(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step079 }) => ({ text: step079.text }),
  })

  .step081(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step080 }) => ({ text: step080.text }),
  })

  .step082(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step081 }) => ({ text: step081.text }),
  })

  .step083(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step082 }) => ({ text: step082.text }),
  })

  .step084(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step083 }) => ({ text: step083.text }),
  })

  .step085(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step084 }) => ({ text: step084.text }),
  })

  .step086(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step085 }) => ({ text: step085.text }),
  })

  .step087(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step086 }) => ({ text: step086.text }),
  })

  .step088(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step087 }) => ({ text: step087.text }),
  })

  .step089(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step088 }) => ({ text: step088.text }),
  })

  .step090(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step089 }) => ({ text: step089.text }),
  })

  .step091(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step090 }) => ({ text: step090.text }),
  })

  .step092(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step091 }) => ({ text: step091.text }),
  })

  .step093(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step092 }) => ({ text: step092.text }),
  })

  .step094(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step093 }) => ({ text: step093.text }),
  })

  .step095(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step094 }) => ({ text: step094.text }),
  })

  .step096(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step095 }) => ({ text: step095.text }),
  })

  .step097(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step096 }) => ({ text: step096.text }),
  })

  .step098(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step097 }) => ({ text: step097.text }),
  })

  .step099(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step098 }) => ({ text: step098.text }),
  })

  .step100(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step099 }) => ({ text: step099.text }),
  })

  .step101(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step100 }) => ({ text: step100.text }),
  })

  .step102(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step101 }) => ({ text: step101.text }),
  })

  .step103(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step102 }) => ({ text: step102.text }),
  })

  .step104(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step103 }) => ({ text: step103.text }),
  })

  .step105(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step104 }) => ({ text: step104.text }),
  })

  .step106(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step105 }) => ({ text: step105.text }),
  })

  .step107(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step106 }) => ({ text: step106.text }),
  })

  .step108(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step107 }) => ({ text: step107.text }),
  })

  .step109(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step108 }) => ({ text: step108.text }),
  })

  .step110(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step109 }) => ({ text: step109.text }),
  })

  .step111(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step110 }) => ({ text: step110.text }),
  })

  .step112(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step111 }) => ({ text: step111.text }),
  })

  .step113(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step112 }) => ({ text: step112.text }),
  })

  .step114(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step113 }) => ({ text: step113.text }),
  })

  .step115(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step114 }) => ({ text: step114.text }),
  })

  .step116(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step115 }) => ({ text: step115.text }),
  })

  .step117(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step116 }) => ({ text: step116.text }),
  })

  .step118(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step117 }) => ({ text: step117.text }),
  })

  .step119(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step118 }) => ({ text: step118.text }),
  })

  .step120(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step119 }) => ({ text: step119.text }),
  })

  .step121(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step120 }) => ({ text: step120.text }),
  })

  .step122(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step121 }) => ({ text: step121.text }),
  })

  .step123(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step122 }) => ({ text: step122.text }),
  })

  .step124(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step123 }) => ({ text: step123.text }),
  })

  .step125(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step124 }) => ({ text: step124.text }),
  })

  .step126(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step125 }) => ({ text: step125.text }),
  })

  .step127(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step126 }) => ({ text: step126.text }),
  })

  .step128(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step127 }) => ({ text: step127.text }),
  })

  .step129(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step128 }) => ({ text: step128.text }),
  })

  .step130(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step129 }) => ({ text: step129.text }),
  })

  .step131(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step130 }) => ({ text: step130.text }),
  })

  .step132(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step131 }) => ({ text: step131.text }),
  })

  .step133(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step132 }) => ({ text: step132.text }),
  })

  .step134(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step133 }) => ({ text: step133.text }),
  })

  .step135(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step134 }) => ({ text: step134.text }),
  })

  .step136(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step135 }) => ({ text: step135.text }),
  })

  .step137(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step136 }) => ({ text: step136.text }),
  })

  .step138(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step137 }) => ({ text: step137.text }),
  })

  .step139(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step138 }) => ({ text: step138.text }),
  })

  .step140(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step139 }) => ({ text: step139.text }),
  })

  .step141(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step140 }) => ({ text: step140.text }),
  })

  .step142(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step141 }) => ({ text: step141.text }),
  })

  .step143(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step142 }) => ({ text: step142.text }),
  })

  .step144(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step143 }) => ({ text: step143.text }),
  })

  .step145(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step144 }) => ({ text: step144.text }),
  })

  .step146(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step145 }) => ({ text: step145.text }),
  })

  .step147(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step146 }) => ({ text: step146.text }),
  })

  .step148(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step147 }) => ({ text: step147.text }),
  })

  .step149(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step148 }) => ({ text: step148.text }),
  })

  .step150(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step149 }) => ({ text: step149.text }),
  })

  .step151(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step150 }) => ({ text: step150.text }),
  })

  .step152(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step151 }) => ({ text: step151.text }),
  })

  .step153(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step152 }) => ({ text: step152.text }),
  })

  .step154(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step153 }) => ({ text: step153.text }),
  })

  .step155(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step154 }) => ({ text: step154.text }),
  })

  .step156(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step155 }) => ({ text: step155.text }),
  })

  .step157(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step156 }) => ({ text: step156.text }),
  })

  .step158(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step157 }) => ({ text: step157.text }),
  })

  .step159(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step158 }) => ({ text: step158.text }),
  })

  .step160(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step159 }) => ({ text: step159.text }),
  })

  .step161(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step160 }) => ({ text: step160.text }),
  })

  .step162(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step161 }) => ({ text: step161.text }),
  })

  .step163(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step162 }) => ({ text: step162.text }),
  })

  .step164(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step163 }) => ({ text: step163.text }),
  })

  .step165(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step164 }) => ({ text: step164.text }),
  })

  .step166(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step165 }) => ({ text: step165.text }),
  })

  .step167(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step166 }) => ({ text: step166.text }),
  })

  .step168(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step167 }) => ({ text: step167.text }),
  })

  .step169(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step168 }) => ({ text: step168.text }),
  })

  .step170(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step169 }) => ({ text: step169.text }),
  })

  .step171(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step170 }) => ({ text: step170.text }),
  })

  .step172(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step171 }) => ({ text: step171.text }),
  })

  .step173(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step172 }) => ({ text: step172.text }),
  })

  .step174(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step173 }) => ({ text: step173.text }),
  })

  .step175(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step174 }) => ({ text: step174.text }),
  })

  .step176(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step175 }) => ({ text: step175.text }),
  })

  .step177(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step176 }) => ({ text: step176.text }),
  })

  .step178(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step177 }) => ({ text: step177.text }),
  })

  .step179(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step178 }) => ({ text: step178.text }),
  })

  .step180(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step179 }) => ({ text: step179.text }),
  })

  .step181(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step180 }) => ({ text: step180.text }),
  })

  .step182(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step181 }) => ({ text: step181.text }),
  })

  .step183(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step182 }) => ({ text: step182.text }),
  })

  .step184(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step183 }) => ({ text: step183.text }),
  })

  .step185(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step184 }) => ({ text: step184.text }),
  })

  .step186(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step185 }) => ({ text: step185.text }),
  })

  .step187(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step186 }) => ({ text: step186.text }),
  })

  .step188(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step187 }) => ({ text: step187.text }),
  })

  .step189(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step188 }) => ({ text: step188.text }),
  })

  .step190(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step189 }) => ({ text: step189.text }),
  })

  .step191(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step190 }) => ({ text: step190.text }),
  })

  .step192(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step191 }) => ({ text: step191.text }),
  })

  .step193(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step192 }) => ({ text: step192.text }),
  })

  .step194(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step193 }) => ({ text: step193.text }),
  })

  .step195(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step194 }) => ({ text: step194.text }),
  })

  .step196(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step195 }) => ({ text: step195.text }),
  })

  .step197(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step196 }) => ({ text: step196.text }),
  })

  .step198(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step197 }) => ({ text: step197.text }),
  })

  .step199(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step198 }) => ({ text: step198.text }),
  })

  .step200(async (_ctx, input) => ({ text: input.text }), {
    input: (_ctx, { step199 }) => ({ text: step199.text }),
  })
  .finish((_ctx, { step200 }) => ({ text: step200.text }))
