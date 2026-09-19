import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { arch, cpus, platform, release } from 'node:os'
import { dirname, relative, resolve, sep } from 'node:path'

/** Version of the report, comparison and run JSON documents. */
export const SCHEMA_VERSION = 1

/**
 * The benchmark suites, in report order. `config` is the vitest config the
 * suite runs under; `label` is its heading in the rendered summary.
 */
export const SUITES = {
  runtime: { label: 'Runtime', config: 'vitest.bench.config.ts' },
  integration: {
    label: 'Integration',
    config: 'vitest.bench.integration.config.ts',
  },
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

export async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true })
  // Rename over the final path so a reader never sees a half-written file.
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, value)
  await rename(temporaryPath, path)
}

export async function writeJson(path, value) {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function hashFiles(root, files) {
  const hash = createHash('sha256')
  for (const file of [...files].sort((left, right) =>
    left.localeCompare(right),
  )) {
    hash.update(toPosixPath(relative(root, file)))
    hash.update('\0')
    hash.update(await readFile(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

export async function collectEnvironment(root) {
  const packageJson = await readJson(resolve(root, 'package.json'))
  const typescriptPackage = await readJson(
    resolve(root, 'node_modules/typescript/package.json'),
  ).catch(() => undefined)

  return {
    architecture: arch(),
    cpu: cpus()[0]?.model ?? 'unknown',
    node: process.version,
    operatingSystem: `${platform()} ${release()}`,
    platform: platform(),
    pnpm: tryExec('pnpm', ['--version'], root),
    pnpmDeclaration: packageJson.packageManager ?? 'unknown',
    typescript: typescriptPackage?.version ?? 'unknown',
  }
}

export function gitCommit(root) {
  return tryExec('git', ['rev-parse', 'HEAD'], root)
}

// Environment metadata is best-effort: a missing tool must not fail a run.
function tryExec(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

export function runCommand(command, args, cwd) {
  return new Promise((settle, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })

    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        settle()
        return
      }
      reject(
        new Error(
          signal
            ? `${command} terminated with signal ${signal}`
            : `${command} exited with code ${code ?? 'unknown'}`,
        ),
      )
    })
  })
}

export function median(values) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

export function medianAbsoluteDeviation(values) {
  const center = median(values)
  if (center === undefined) return undefined
  return median(values.map((value) => Math.abs(value - center)))
}

export function toPosixPath(path) {
  return path.split(sep).join('/')
}

export async function pathExists(path) {
  return stat(path)
    .then(() => true)
    .catch(() => false)
}
