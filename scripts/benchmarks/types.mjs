import { spawnSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/** @type {Array<readonly [string, () => string]>} */
const CASES = [
  ['linear-contract-100', () => linearDeclaration(100)],
  ['linear-implementation-100', () => linearImplementation(100)],
  ['branch-50', () => branchFanout(50)],
  ['parallel-50', () => parallelFanout(50)],
  ['map-25', () => mapChain(25)],
]

const HEADER = `
import { t } from '@nmtjs/type'

import { defineTask, defineWorkflow, implementWorkflow } from '../../src/index.ts'
`

export async function runTypeBenchmarks(root) {
  const generatedDirectory = resolve(
    root,
    'packages/workflows/bench/.generated-types',
  )
  await rm(generatedDirectory, { force: true, recursive: true })
  await mkdir(generatedDirectory, { recursive: true })

  try {
    return await collectTypeBenchmarkCases(root, generatedDirectory)
  } finally {
    await rm(generatedDirectory, { force: true, recursive: true })
  }
}

async function collectTypeBenchmarkCases(root, generatedDirectory) {
  const cases = []
  for (const [name, createSource] of CASES) {
    const sourcePath = resolve(generatedDirectory, `${name}.ts`)
    const configPath = resolve(generatedDirectory, `tsconfig.${name}.json`)
    await writeFile(sourcePath, `${createSource().trim()}\n`)
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          extends: '../../tsconfig.json',
          compilerOptions: {
            incremental: false,
            noEmit: true,
            rootDir: '../..',
          },
          files: [`./${name}.ts`],
        },
        null,
        2,
      )}\n`,
    )

    const result = spawnSync(
      'pnpm',
      [
        'exec',
        'tsc',
        '-p',
        configPath,
        '--noEmit',
        '--pretty',
        'false',
        '--diagnostics',
        '--extendedDiagnostics',
        '--incremental',
        'false',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: process.env,
        maxBuffer: 16 * 1024 * 1024,
      },
    )
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    if (result.error) throw result.error
    if (result.status !== 0) {
      const firstErrors = output
        .split('\n')
        .filter((line) => line.includes('error TS'))
        .slice(0, 10)
        .join('\n')
      throw new Error(
        `Type benchmark ${name} failed${firstErrors ? `:\n${firstErrors}` : ''}`,
      )
    }

    cases.push(
      metricCase(
        name,
        'types',
        parseIntegerMetric(output, 'Types'),
        'type-count',
      ),
      metricCase(
        name,
        'instantiations',
        parseIntegerMetric(output, 'Instantiations'),
        'type-count',
      ),
      metricCase(
        name,
        'check-time',
        parseTimeMetric(output, 'Check time'),
        'type-time',
        'ms',
      ),
      metricCase(
        name,
        'total-time',
        parseTimeMetric(output, 'Total time'),
        'type-time',
        'ms',
      ),
      metricCase(
        name,
        'memory',
        parseMemoryMetric(output, 'Memory used'),
        'type-memory',
        'bytes',
      ),
    )
  }

  return cases
}

function metricCase(name, metric, value, category, unit = 'count') {
  return {
    category,
    id: `workflows types > ${name} > ${metric}`,
    metric,
    name: `${name} ${metric}`,
    unit,
    value,
  }
}

function parseIntegerMetric(output, label) {
  const value = metric(output, label).replaceAll(',', '')
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error(`TypeScript diagnostics did not include a valid ${label}`)
  }
  return parsed
}

function parseTimeMetric(output, label) {
  const value = metric(output, label)
  const match = value.match(/^([\d.]+)(ms|s)$/)
  if (!match) {
    throw new Error(`TypeScript diagnostics did not include a valid ${label}`)
  }
  const parsed = Number.parseFloat(match[1])
  return match[2] === 's' ? parsed * 1000 : parsed
}

function parseMemoryMetric(output, label) {
  const value = metric(output, label)
  const match = value.match(/^([\d.]+)(K|M|G)?B?$/i)
  if (!match) {
    throw new Error(`TypeScript diagnostics did not include a valid ${label}`)
  }
  const factor = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }
  return Number.parseFloat(match[1]) * (factor[match[2]?.toUpperCase()] ?? 1)
}

function metric(output, label) {
  return (
    output.match(new RegExp(`^${label}:\\s+([^\\n]+)$`, 'm'))?.[1]?.trim() ?? ''
  )
}

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
${HEADER}
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
  const implementationSteps = Array.from({ length: count }, (_, index) => {
    const step = `step${String(index + 1).padStart(3, '0')}`
    const previous =
      index === 0 ? undefined : `step${String(index).padStart(3, '0')}`
    const input = previous
      ? `(_ctx, { ${previous} }) => ({ text: ${previous}.text })`
      : `(_ctx, _outputs, input) => ({ text: input.seed })`
    return `
  .${step}(async (_ctx, input) => ({ text: input.text }), {
    input: ${input},
  })`
  }).join('\n')
  const last = `step${String(count).padStart(3, '0')}`

  return `
${linearDeclaration(count)}

export const implementation = implementWorkflow(workflow)
${implementationSteps}
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
  const implementations = Array.from({ length: count }, (_, index) => {
    const name = `case${String(index + 1).padStart(3, '0')}`
    return `
          ${name}: activity(
            async (_ctx, input) => ({ kind: '${name}' as const, text: input.text }),
            { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
          ),`
  }).join('')

  return `
${HEADER}
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
    cases: ({ activity }) => ({${implementations}
    }),
  })
  .finish((_ctx, { choice }) => ({ text: choice.text }))
`
}

function parallelFanout(count) {
  const parts = Array.from({ length: count }, (_, index) => {
    const name = `part${String(index + 1).padStart(3, '0')}`
    return `
      ${name}: activity({ input: textSchema, output: textSchema }),`
  }).join('')
  const implementations = Array.from({ length: count }, (_, index) => {
    const name = `part${String(index + 1).padStart(3, '0')}`
    return `
        ${name}: activity(
          async (_ctx, input) => ({ text: input.text }),
          { input: (_ctx, _outputs, input) => ({ text: input.seed }) },
        ),`
  }).join('')

  return `
${HEADER}
${schemaHelpers()}

export const workflow = defineWorkflow({
  name: 'bench-parallel-${count}',
  input: inputSchema,
  output: t.object({ text: t.string() }),
})
  .parallel('parts', ({ activity }) => ({${parts}
  }))
  .build()

export const implementation = implementWorkflow(workflow)
  .parts(({ activity }) => ({${implementations}
  }))
  .finish((_ctx, { parts }) => ({ text: parts.part001.text }))
`
}

function mapChain(count) {
  const nodes = Array.from({ length: count }, (_, index) => {
    const name = `map${String(index + 1).padStart(3, '0')}`
    return `
  .mapTask('${name}', embeddingTask, {
    item: textSchema,
    mode: 'wait-all',
  })`
  }).join('\n')
  const implementations = Array.from({ length: count }, (_, index) => {
    const name = `map${String(index + 1).padStart(3, '0')}`
    const previous =
      index === 0 ? undefined : `map${String(index).padStart(3, '0')}`
    const items = previous
      ? `(_ctx, { ${previous} }) => ${previous}.items.map((entry) => entry.output)`
      : `(_ctx, _outputs, input) => [{ text: input.seed }]`
    return `
  .${name}(embeddingTask, {
    items: ${items},
    input: (_ctx, _outputs, item) => ({ text: item.text }),
  })`
  }).join('\n')
  const last = `map${String(count).padStart(3, '0')}`

  return `
${HEADER}
${schemaHelpers()}

const embeddingTask = defineTask({
  name: 'bench.embedding',
  input: textSchema,
  output: textSchema,
})

export const workflow = defineWorkflow({
  name: 'bench-map-${count}',
  input: inputSchema,
  output: textSchema,
})
${nodes}
  .build()

export const implementation = implementWorkflow(workflow)
${implementations}
  .finish((_ctx, { ${last} }) => ({ text: ${last}.items.at(0)?.output.text ?? '' }))
`
}
