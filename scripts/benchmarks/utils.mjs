import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
  mkdir,
} from 'node:fs/promises'
import { cpus, arch, platform, release } from 'node:os'
import { dirname, relative, resolve, sep } from 'node:path'

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.benchmark',
  'benchmark-results',
  'coverage',
  'dist',
  'node_modules',
])

export function parseArguments(argv) {
  const result = { _: [] }

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (!argument.startsWith('--')) {
      result._.push(argument)
      continue
    }

    const [rawKey, inlineValue] = argument.slice(2).split('=', 2)
    if (inlineValue !== undefined) {
      result[rawKey] = inlineValue
      continue
    }

    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      result[rawKey] = next
      index++
    } else {
      result[rawKey] = true
    }
  }

  return result
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporaryPath, path)
}

export async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, value)
  await rename(temporaryPath, path)
}

export async function findFiles(root, predicate, directory = root) {
  const files = []
  const entries = await readdir(directory, { withFileTypes: true })

  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        files.push(...(await findFiles(root, predicate, path)))
      }
      continue
    }
    if (entry.isFile() && predicate(path, toPosixPath(relative(root, path)))) {
      files.push(path)
    }
  }

  return files.sort((left, right) => left.localeCompare(right))
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
    pnpm: commandVersion('pnpm', root),
    pnpmDeclaration: packageJson.packageManager ?? 'unknown',
    typescript: typescriptPackage?.version ?? 'unknown',
  }
}

function commandVersion(command, cwd) {
  try {
    return execFileSync(command, ['--version'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

export function gitCommit(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.stdio ?? 'inherit',
    })

    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
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
