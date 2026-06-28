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
  name: 'bench-map-25',
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
  .finish((_ctx, { map025 }) => ({
    text: map025.items.at(0)?.output.text ?? '',
  }))
