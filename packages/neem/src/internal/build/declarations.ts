import { existsSync, globSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

import type {
  NeemArtifactEntry,
  NeemConfig,
  NeemMarkedRuntimeDeclaration,
  NeemResolvedConfig,
  NeemResolvedRuntimeDeclaration,
} from '../../shared/types.ts'
import { isNeemRuntimeDeclaration } from '../../public/config.ts'
import { importDefault } from '../utils.ts'
import { resolveBuildEntry } from './resolver.ts'

const SOURCE_EXTENSIONS = ['ts', 'mts', 'js', 'mjs', 'cts', 'cjs'] as const

const RUNTIME_DECLARATION_FILES = conventionalFiles('neem.runtime')
const PLANNER_FILES = conventionalFiles('neem.planner')

export async function resolveNeemRuntimeDeclarations(
  configFile: string,
  config: NeemConfig,
): Promise<NeemResolvedConfig> {
  const files = resolveRuntimeProjectFiles(configFile, config.runtimes)
  const runtimes = new Map<string, NeemResolvedRuntimeDeclaration>()

  for (const file of files) {
    const declaration = await loadRuntimeDeclaration(file)
    validateRuntimeDeclaration(file, declaration)
    const planner = resolveRuntimePlanner(file, declaration)
    const name = resolveRuntimeName(file, declaration)
    if (runtimes.has(name)) {
      throw new Error(
        `Duplicate runtime name [${name}] in runtime declaration [${file}]`,
      )
    }
    runtimes.set(name, { name, file, declaration, planner })
  }

  return Object.freeze({ ...config, runtimes: Object.fromEntries(runtimes) })
}

function conventionalFiles(stem: string): readonly string[] {
  return SOURCE_EXTENSIONS.map((extension) => `${stem}.${extension}`)
}

function resolveRuntimeProjectFiles(
  configFile: string,
  entries: readonly string[],
): readonly string[] {
  const configDir = dirname(configFile)
  const positives: string[] = []
  const negatives = new Set<string>()

  for (const entry of entries) {
    const negated = entry.startsWith('!')
    const raw = negated ? entry.slice(1) : entry
    const files = expandRuntimeProjectEntry(configDir, raw)

    if (!negated && files.length === 0) {
      throw new Error(
        `Runtime project entry [${entry}] matched no files or folders`,
      )
    }
    for (const file of files) {
      if (negated) negatives.add(file)
      else positives.push(file)
    }
  }

  const selected = new Set<string>()
  for (const file of positives) {
    if (!negatives.has(file)) selected.add(file)
  }

  return Array.from(selected)
}

async function loadRuntimeDeclaration(
  file: string,
): Promise<NeemMarkedRuntimeDeclaration> {
  const declaration = await importDefault<unknown>(file, { cacheBust: true })
  if (declaration === undefined) {
    throw new Error(
      `Runtime declaration file [${file}] must have a default export`,
    )
  }
  if (!isNeemRuntimeDeclaration(declaration)) {
    throw new Error(
      `Runtime declaration file [${file}] default export must be a marked runtime declaration produced by defineRuntime or a package create*Runtime helper`,
    )
  }
  return declaration
}

function expandRuntimeProjectEntry(
  configDir: string,
  entry: string,
): readonly string[] {
  const pattern = isAbsolute(entry) ? entry : resolve(configDir, entry)
  return globSync(pattern).sort().map(resolveRuntimeProjectFile)
}

function resolveRuntimeProjectFile(path: string): string {
  const stats = statSync(path)
  if (stats.isDirectory()) {
    const file = findConventionalFile(path, RUNTIME_DECLARATION_FILES)
    if (!file) {
      throw new Error(
        `Runtime folder [${path}] has no conventional runtime declaration file`,
      )
    }
    return file
  }

  if (!stats.isFile()) {
    throw new Error(`Runtime project entry [${path}] is not a file or folder`)
  }

  return path
}

function findConventionalFile(
  directory: string,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const candidate = resolve(directory, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function resolveRuntimePlanner(
  declarationFile: string,
  declaration: NeemMarkedRuntimeDeclaration,
): NeemArtifactEntry {
  if (declaration.planner) {
    return resolveBuildEntry(declarationFile, declaration.planner)
  }

  const conventional = findConventionalFile(
    dirname(declarationFile),
    PLANNER_FILES,
  )
  if (conventional) return conventional

  throw new Error(
    `Runtime declaration file [${declarationFile}] has no resolved planner entry`,
  )
}

function resolveRuntimeName(
  declarationFile: string,
  declaration: NeemMarkedRuntimeDeclaration,
): string {
  const explicit = declaration.name?.trim()
  if (explicit) return explicit

  const packageName = findNearestPackageName(dirname(declarationFile))
  if (packageName) return packageName

  throw new Error(
    `Runtime declaration file [${declarationFile}] must declare a runtime name or be inside a package with package.json#name`,
  )
}

function findNearestPackageName(directory: string): string | undefined {
  let current = directory
  while (true) {
    const packageFile = resolve(current, 'package.json')
    if (existsSync(packageFile)) {
      const raw = JSON.parse(readFileSync(packageFile, 'utf8')) as {
        name?: unknown
      }
      if (typeof raw.name === 'string' && raw.name.trim()) {
        return raw.name.trim()
      }
    }

    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function validateRuntimeDeclaration(
  file: string,
  declaration: NeemMarkedRuntimeDeclaration,
): void {
  if (!declaration.worker && !declaration.host?.entry) {
    throw new Error(
      `Runtime declaration file [${file}] must provide a worker or a custom host entry`,
    )
  }
  if (declaration.worker && !declaration.worker.entry) {
    throw new Error(
      `Runtime declaration file [${file}] worker entry is required`,
    )
  }
}
