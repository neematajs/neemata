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
  name: 'bench-map-10',
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
  .finish((_ctx, { map010 }) => ({
    text: map010.items.at(0)?.output.text ?? '',
  }))
