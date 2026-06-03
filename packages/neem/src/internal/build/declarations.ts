import { existsSync, globSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type {
  NeemConfig,
  NeemMarkedRuntimeDeclaration,
  NeemResolvedConfig,
  NeemResolvedRuntimeDeclaration,
} from '../../shared/types.ts'
// import type {
//   NeemConfig,
//   NeemMarkedRuntimeDeclaration,
//   NeemResolvedConfig,
//   NeemResolvedRuntimeDeclaration,
// } from '../../public/config.ts'
import { isNeemRuntimeDeclaration } from '../../public/config.ts'
import { resolveBuildEntry } from './resolver.ts'

const runtimeDeclarationFiles = [
  'neem.runtime.ts',
  'neem.runtime.mts',
  'neem.runtime.js',
  'neem.runtime.mjs',
] as const

const plannerFiles = [
  'neem.planner.ts',
  'neem.planner.mts',
  'neem.planner.js',
  'neem.planner.mjs',
] as const

type RuntimeProjectMatch = { entry: string; file: string; directory: string }

type EntryModule = { default?: unknown }

export async function resolveNeemRuntimeDeclarations(
  configFile: string,
  config: NeemConfig,
): Promise<NeemResolvedConfig> {
  const matches = resolveRuntimeProjectFiles(configFile, config.runtimes)
  const runtimes = new Map<string, NeemResolvedRuntimeDeclaration>()

  for (const match of matches) {
    const declaration = await loadRuntimeDeclaration(match.file)
    const planner = resolveRuntimePlanner(match.file, declaration)
    const name = resolveRuntimeName(match.file, declaration)
    if (runtimes.has(name)) {
      throw new Error(
        `Duplicate runtime name [${name}] in runtime declaration [${match.file}]`,
      )
    }
    validateRuntimeDeclaration(match.file, declaration)
    runtimes.set(name, {
      name,
      file: match.file,
      directory: match.directory,
      declaration,
      planner,
    })
  }

  return Object.freeze({ ...config, runtimes: Object.fromEntries(runtimes) })
}

export function resolveRuntimeProjectFiles(
  configFile: string,
  entries: readonly string[],
): readonly RuntimeProjectMatch[] {
  const configDir = dirname(configFile)
  const positives: RuntimeProjectMatch[] = []
  const negatives = new Set<string>()

  for (const entry of entries) {
    const negated = entry.startsWith('!')
    const raw = negated ? entry.slice(1) : entry
    const matches = expandRuntimeProjectEntry(configDir, raw)

    if (!negated && matches.length === 0) {
      throw new Error(
        `Runtime project entry [${entry}] matched no files or folders`,
      )
    }
    for (const match of matches) {
      if (negated) negatives.add(match.file)
      else positives.push({ ...match, entry })
    }
  }

  const selected = new Map<string, RuntimeProjectMatch>()
  for (const match of positives) {
    if (!negatives.has(match.file)) selected.set(match.file, match)
  }

  return [...selected.values()]
}

async function loadRuntimeDeclaration(
  file: string,
): Promise<NeemMarkedRuntimeDeclaration> {
  const module = (await import(
    `${pathToFileURL(file).href}?t=${Date.now()}`
  )) as EntryModule
  if (!('default' in module)) {
    throw new Error(
      `Runtime declaration file [${file}] must have a default export`,
    )
  }
  if (!isNeemRuntimeDeclaration(module.default)) {
    throw new Error(
      `Runtime declaration file [${file}] default export must be a marked runtime declaration produced by defineRuntime or a package create*Runtime helper`,
    )
  }
  return module.default
}

function expandRuntimeProjectEntry(
  configDir: string,
  entry: string,
): readonly RuntimeProjectMatch[] {
  const pattern = isAbsolute(entry) ? entry : resolve(configDir, entry)
  const matches = globSync(pattern).sort()

  return matches.map((match) => resolveRuntimeProjectMatch(String(match)))
}

function resolveRuntimeProjectMatch(path: string): RuntimeProjectMatch {
  const stats = statSync(path)
  if (stats.isDirectory()) {
    const file = resolveRuntimeDeclarationFile(path)
    if (!file) {
      throw new Error(
        `Runtime folder [${path}] has no conventional runtime declaration file`,
      )
    }
    return { entry: path, file, directory: path }
  }

  if (!stats.isFile()) {
    throw new Error(`Runtime project entry [${path}] is not a file or folder`)
  }

  return { entry: path, file: path, directory: dirname(path) }
}

function resolveRuntimeDeclarationFile(directory: string): string | undefined {
  for (const file of runtimeDeclarationFiles) {
    const candidate = resolve(directory, file)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function resolveRuntimePlanner(
  declarationFile: string,
  declaration: NeemMarkedRuntimeDeclaration,
): string {
  const explicit = resolveBuildEntry(declarationFile, declaration.planner)
  if (explicit) return String(explicit)

  for (const file of plannerFiles) {
    const candidate = resolve(dirname(declarationFile), file)
    if (existsSync(candidate)) return candidate
  }

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
