import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const benchDir = dirname(fileURLToPath(import.meta.url))
const generatedDir = join(benchDir, 'generated')

mkdirSync(generatedDir, { recursive: true })

function writeGenerated(name, content) {
  writeFileSync(join(generatedDir, name), `${content.trim()}\n`)
}

function writeConfig(name, files) {
  writeFileSync(
    join(benchDir, name),
    `${JSON.stringify(
      {
        extends: '../tsconfig.json',
        compilerOptions: {
          rootDir: '..',
          noEmit: true,
          tsBuildInfoFile: `../node_modules/.tmp/${name}.tsbuildinfo`,
        },
        files: files.map((file) => `./generated/${file}`),
      },
      null,
      2,
    )}\n`,
  )
}

const header = `
import { t } from '@nmtjs/type'

import { defineTask, defineWorkflow, implementWorkflow } from '../../src/index.ts'
`

function schemaHelpers() {
  return `
const inputSchema = t.object({ seed: t.string() })
const textSchema = t.object({ text: t.string() })
`
}

function activityStep(index) {
  const name = `step${String(index).padStart(3, '0')}`
  return `
  .activity('${name}', {
    input: textSchema,
    output: textSchema,
  })`
}

function linearDeclaration(count) {
  return `
${header}
${schemaHelpers()}

export const workflow = defineWorkflow({
  name: 'bench-linear-contract-${count}',
  input: inputSchema,
  output: textSchema,
})
${Array.from({ length: count }, (_, index) => activityStep(index + 1)).join('\n')}
  .build()
`
}

function linearImplementation(count) {
  const implSteps = Array.from({ length: count }, (_, index) => {
    const step = `step${String(index + 1).padStart(3, '0')}`
    const previous =
      index === 0 ? undefined : `step${String(index).padStart(3, '0')}`
    const inputMapper = previous
      ? `(_ctx, { ${previous} }) => ({ text: ${previous}.text })`
      : `(_ctx, _outputs, input) => ({ text: input.seed })`
    return `
  .${step}(async (_ctx, input) => ({ text: input.text }), {
    input: ${inputMapper},
  })`
  }).join('\n')

  const last = `step${String(count).padStart(3, '0')}`

  return `
${linearDeclaration(count)}

export const implementation = implementWorkflow(workflow)
${implSteps}
  .finish((_ctx, { ${last} }) => ({ text: ${last}.text }))
`
}

function branchFanout(count) {
  const cases = Array.from({ length: count }, (_, index) => {
    const name = `case${String(index + 1).padStart(3, '0')}`
    return `
      ${name}: activity({
        input: textSchema,
        output: t.object({ kind: t.literal('${name}'), text: t.string() }),
      }),`
  }).join('')

  const implCases = Array.from({ length: count }, (_, index) => {
    const name = `case${String(index + 1).padStart(3, '0')}`
    return `
          ${name}: activity(
            async (_ctx, input) => ({ kind: '${name}' as const, text: input.text }),
            { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
          ),`
  }).join('')

  return `
${header}
${schemaHelpers()}

export const workflow = defineWorkflow({
  name: 'bench-branch-${count}',
  input: inputSchema,
  output: t.object({ text: t.string() }),
})
  .branch('choice', {
    cases: ({ activity }) => ({${cases}
    }),
  })
  .build()

export const implementation = implementWorkflow(workflow)
  .choice({
    select: (_ctx, _outputs, _input): keyof typeof workflow.nodes[0]['cases'] => 'case001',
    cases: ({ activity }) => ({${implCases}
    }),
  })
  .finish((_ctx, { choice }) => ({ text: choice.text }))
`
}

function parallelFanout(count) {
  const cases = Array.from({ length: count }, (_, index) => {
    const name = `part${String(index + 1).padStart(3, '0')}`
    return `
      ${name}: activity({
        input: textSchema,
        output: textSchema,
      }),`
  }).join('')

  const implCases = Array.from({ length: count }, (_, index) => {
    const name = `part${String(index + 1).padStart(3, '0')}`
    return `
        ${name}: activity(
          async (_ctx, input) => ({ text: input.text }),
          { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
        ),`
  }).join('')

  return `
${header}
${schemaHelpers()}

export const workflow = defineWorkflow({
  name: 'bench-parallel-${count}',
  input: inputSchema,
  output: t.object({ text: t.string() }),
})
  .parallel('parts', ({ activity }) => ({${cases}
  }))
  .build()

export const implementation = implementWorkflow(workflow)
  .parts(({ activity }) => ({${implCases}
  }))
  .finish((_ctx, { parts }) => ({ text: parts.part001.text }))
`
}

function mapChain(count) {
  const taskName = 'embeddingTask'
  const task = `
const ${taskName} = defineTask({
  name: 'bench.embedding',
  input: textSchema,
  output: textSchema,
})
`

  const nodes = Array.from({ length: count }, (_, index) => {
    const name = `map${String(index + 1).padStart(3, '0')}`
    return `
  .mapTask('${name}', ${taskName}, {
    item: textSchema,
    mode: 'wait-all',
  })`
  }).join('\n')

  const impl = Array.from({ length: count }, (_, index) => {
    const name = `map${String(index + 1).padStart(3, '0')}`
    const previous =
      index === 0 ? undefined : `map${String(index).padStart(3, '0')}`
    const items = previous
      ? `(_ctx, { ${previous} }) => ${previous}.items.map((entry) => entry.output)`
      : `(_ctx, _outputs, input) => [{ text: input.seed }]`
    return `
  .${name}(${taskName}, {
    items: ${items},
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })`
  }).join('\n')

  const last = `map${String(count).padStart(3, '0')}`

  return `
${header}
${schemaHelpers()}
${task}

export const workflow = defineWorkflow({
  name: 'bench-map-${count}',
  input: inputSchema,
  output: textSchema,
})
${nodes}
  .build()

export const implementation = implementWorkflow(workflow)
${impl}
  .finish((_ctx, { ${last} }) => ({ text: ${last}.items.at(0)?.output.text ?? '' }))
`
}

writeGenerated('baseline.ts', `${header}\nexport const ok = true`)

for (const count of [10, 25, 50, 75, 90, 95, 99, 100, 200]) {
  writeGenerated(`linear-contract-${count}.ts`, linearDeclaration(count))
  writeGenerated(`linear-impl-${count}.ts`, linearImplementation(count))
}

for (const count of [10, 25, 50, 100]) {
  writeGenerated(`branch-${count}.ts`, branchFanout(count))
  writeGenerated(`parallel-${count}.ts`, parallelFanout(count))
}

for (const count of [10, 25, 50]) {
  writeGenerated(`map-${count}.ts`, mapChain(count))
}

writeConfig('tsconfig.baseline.json', ['baseline.ts'])

for (const count of [10, 25, 50, 75, 90, 95, 99, 100, 200]) {
  writeConfig(`tsconfig.linear-contract-${count}.json`, [
    `linear-contract-${count}.ts`,
  ])
  writeConfig(`tsconfig.linear-impl-${count}.json`, [`linear-impl-${count}.ts`])
}

for (const count of [10, 25, 50, 100]) {
  writeConfig(`tsconfig.branch-${count}.json`, [`branch-${count}.ts`])
  writeConfig(`tsconfig.parallel-${count}.json`, [`parallel-${count}.ts`])
}

for (const count of [10, 25, 50]) {
  writeConfig(`tsconfig.map-${count}.json`, [`map-${count}.ts`])
}
