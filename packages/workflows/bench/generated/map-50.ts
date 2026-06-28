import { t } from '@nmtjs/type'

import {
  defineTask,
  defineWorkflow,
  implementWorkflow,
} from '../../src/index.ts'

const inputSchema = t.object({ seed: t.string() })
const textSchema = t.object({ text: t.string() })

const embeddingTask = defineTask({
  name: 'bench.embedding',
  input: textSchema,
  output: textSchema,
})

export const workflow = defineWorkflow({
  name: 'bench-map-50',
  input: inputSchema,
  output: textSchema,
})
  .mapTask('map001', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map002', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map003', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map004', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map005', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map006', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map007', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map008', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map009', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map010', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map011', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map012', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map013', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map014', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map015', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map016', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map017', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map018', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map019', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map020', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map021', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map022', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map023', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map024', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map025', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map026', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map027', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map028', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map029', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map030', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map031', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map032', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map033', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map034', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map035', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map036', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map037', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map038', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map039', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map040', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map041', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map042', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map043', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map044', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map045', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map046', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map047', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map048', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map049', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })

  .mapTask('map050', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })
  .build()

export const implementation = implementWorkflow(workflow)
  .map001(embeddingTask, {
    items: (_ctx, _outputs, input) => [{ text: input.seed }],
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map002(embeddingTask, {
    items: (_ctx, { map001 }) => map001.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map003(embeddingTask, {
    items: (_ctx, { map002 }) => map002.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map004(embeddingTask, {
    items: (_ctx, { map003 }) => map003.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map005(embeddingTask, {
    items: (_ctx, { map004 }) => map004.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map006(embeddingTask, {
    items: (_ctx, { map005 }) => map005.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map007(embeddingTask, {
    items: (_ctx, { map006 }) => map006.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map008(embeddingTask, {
    items: (_ctx, { map007 }) => map007.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map009(embeddingTask, {
    items: (_ctx, { map008 }) => map008.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map010(embeddingTask, {
    items: (_ctx, { map009 }) => map009.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map011(embeddingTask, {
    items: (_ctx, { map010 }) => map010.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map012(embeddingTask, {
    items: (_ctx, { map011 }) => map011.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map013(embeddingTask, {
    items: (_ctx, { map012 }) => map012.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map014(embeddingTask, {
    items: (_ctx, { map013 }) => map013.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map015(embeddingTask, {
    items: (_ctx, { map014 }) => map014.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map016(embeddingTask, {
    items: (_ctx, { map015 }) => map015.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map017(embeddingTask, {
    items: (_ctx, { map016 }) => map016.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map018(embeddingTask, {
    items: (_ctx, { map017 }) => map017.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map019(embeddingTask, {
    items: (_ctx, { map018 }) => map018.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map020(embeddingTask, {
    items: (_ctx, { map019 }) => map019.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map021(embeddingTask, {
    items: (_ctx, { map020 }) => map020.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map022(embeddingTask, {
    items: (_ctx, { map021 }) => map021.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map023(embeddingTask, {
    items: (_ctx, { map022 }) => map022.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map024(embeddingTask, {
    items: (_ctx, { map023 }) => map023.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map025(embeddingTask, {
    items: (_ctx, { map024 }) => map024.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map026(embeddingTask, {
    items: (_ctx, { map025 }) => map025.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map027(embeddingTask, {
    items: (_ctx, { map026 }) => map026.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map028(embeddingTask, {
    items: (_ctx, { map027 }) => map027.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map029(embeddingTask, {
    items: (_ctx, { map028 }) => map028.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map030(embeddingTask, {
    items: (_ctx, { map029 }) => map029.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map031(embeddingTask, {
    items: (_ctx, { map030 }) => map030.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map032(embeddingTask, {
    items: (_ctx, { map031 }) => map031.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map033(embeddingTask, {
    items: (_ctx, { map032 }) => map032.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map034(embeddingTask, {
    items: (_ctx, { map033 }) => map033.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map035(embeddingTask, {
    items: (_ctx, { map034 }) => map034.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map036(embeddingTask, {
    items: (_ctx, { map035 }) => map035.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map037(embeddingTask, {
    items: (_ctx, { map036 }) => map036.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map038(embeddingTask, {
    items: (_ctx, { map037 }) => map037.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map039(embeddingTask, {
    items: (_ctx, { map038 }) => map038.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map040(embeddingTask, {
    items: (_ctx, { map039 }) => map039.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map041(embeddingTask, {
    items: (_ctx, { map040 }) => map040.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map042(embeddingTask, {
    items: (_ctx, { map041 }) => map041.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map043(embeddingTask, {
    items: (_ctx, { map042 }) => map042.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map044(embeddingTask, {
    items: (_ctx, { map043 }) => map043.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map045(embeddingTask, {
    items: (_ctx, { map044 }) => map044.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map046(embeddingTask, {
    items: (_ctx, { map045 }) => map045.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map047(embeddingTask, {
    items: (_ctx, { map046 }) => map046.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map048(embeddingTask, {
    items: (_ctx, { map047 }) => map047.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map049(embeddingTask, {
    items: (_ctx, { map048 }) => map048.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })

  .map050(embeddingTask, {
    items: (_ctx, { map049 }) => map049.items.map((entry) => entry.output),
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })
  .finish((_ctx, { map050 }) => ({
    text: map050.items.at(0)?.output.text ?? '',
  }))
