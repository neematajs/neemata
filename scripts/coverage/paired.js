#!/usr/bin/env node

import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { parseArguments, pathExists, runCommand } from '../benchmarks/utils.js'
import { compareReports } from './compare.js'

const args = parseArguments(process.argv.slice(2))
const headRoot = resolve(args.head || process.cwd())
const requestedBaseRoot = args.base ? resolve(args.base) : undefined
const outputRoot = resolve(headRoot, args.output || '.coverage/report')

// Each revision is measured with its own runner, so the base keeps the suite
// selection it had when it was merged.
const headRunner = resolve(headRoot, 'scripts/coverage/run.js')
const baseRunner = requestedBaseRoot
  ? resolve(requestedBaseRoot, 'scripts/coverage/run.js')
  : undefined
const baseAvailable = Boolean(baseRunner && (await pathExists(baseRunner)))

await mkdir(outputRoot, { recursive: true })
const headOutput = resolve(outputRoot, 'head.json')
const baseOutput = resolve(outputRoot, 'base.json')

console.log('\n[coverage] head')
await runCommand(
  process.execPath,
  [headRunner, '--root', headRoot, '--output', headOutput],
  { cwd: headRoot },
)
if (baseAvailable) {
  console.log('\n[coverage] base')
  await runCommand(
    process.execPath,
    [baseRunner, '--root', requestedBaseRoot, '--output', baseOutput],
    { cwd: requestedBaseRoot },
  )
}

const { summary } = await compareReports({
  base: baseAvailable ? baseOutput : undefined,
  head: headOutput,
  output: resolve(outputRoot, 'comparison.json'),
  summary: resolve(outputRoot, 'summary.md'),
})
process.stdout.write(`\n${summary}`)
