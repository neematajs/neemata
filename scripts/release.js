#!/usr/bin/env node

// Versions are committed and bumped by hand in PRs; the publish workflows only
// verify them against npm before releasing.
//
//   node scripts/release.js stack              guard a stack release, print its version
//   node scripts/release.js package <dir>      guard a standalone release, print its version
//   node scripts/release.js bump-stack <ver>   set the lockstep stack version

import { execFile } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs, promisify } from 'node:util'

const packagesDir = new URL('../packages/', import.meta.url)
// Released on their own schedule; everything else is the lockstep stack.
const standalone = ['proxy', 'prom-client']

const manifestUrl = (dir) => new URL(`${dir}/package.json`, packagesDir)
const readManifest = (dir) => JSON.parse(readFileSync(manifestUrl(dir), 'utf8'))

function stackDirs() {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !standalone.includes(entry.name))
    .map((entry) => entry.name)
    .sort()
}

async function isPublished(name, version) {
  try {
    const { stdout } = await promisify(execFile)(
      'npm',
      ['view', `${name}@${version}`, 'version', '--json'],
      { encoding: 'utf8' },
    )
    // A known package without that version exits 0 with empty output.
    return stdout.trim() !== ''
  } catch (error) {
    // A never-published package is a 404, not a registry failure.
    if (`${error.stdout}${error.stderr}`.includes('E404')) return false
    throw error
  }
}

async function guardStack() {
  const manifests = stackDirs().map(readManifest)
  const versions = new Set(manifests.map((manifest) => manifest.version))
  if (versions.size !== 1) {
    const listed = manifests.map((m) => `  ${m.name}@${m.version}`).join('\n')
    throw new Error(`Stack package versions differ:\n${listed}`)
  }
  const [version] = versions

  const published = []
  for (const { name } of manifests)
    if (await isPublished(name, version)) published.push(name)
  if (published.length > 0)
    throw new Error(
      `${version} is already published for ${published.join(', ')}`,
    )

  // The stack publishes `workspace:^` ranges against these committed versions.
  for (const dir of standalone) {
    const { name, version: dependencyVersion } = readManifest(dir)
    if (!(await isPublished(name, dependencyVersion)))
      throw new Error(
        `${name}@${dependencyVersion} is committed but not published; release it first`,
      )
  }
  return version
}

async function guardPackage(dir) {
  if (!standalone.includes(dir))
    throw new Error(`Expected one of: ${standalone.join(', ')}`)
  const { name, version } = readManifest(dir)
  if (await isPublished(name, version))
    throw new Error(`${name}@${version} is already published`)
  return version
}

function bumpStack(version) {
  if (!version) throw new Error('Missing version')
  for (const dir of stackDirs()) {
    const manifest = readManifest(dir)
    manifest.version = version
    writeFileSync(manifestUrl(dir), `${JSON.stringify(manifest, null, 2)}\n`)
  }
  return version
}

const { positionals } = parseArgs({ allowPositionals: true })
const [command, argument] = positionals
const commands = {
  stack: guardStack,
  package: () => guardPackage(argument),
  'bump-stack': () => bumpStack(argument),
}

if (!Object.hasOwn(commands, command)) {
  process.stderr.write(`Unknown command: ${command}\n`)
  process.exit(1)
}
try {
  process.stdout.write(await commands[command]())
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
}
