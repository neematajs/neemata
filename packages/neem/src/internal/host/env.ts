import type { Manifest } from '../manifest/manifest.ts'

export type CreateRuntimeEnvOptions = {
  manifest: Manifest
  runtimeName: string
  executionEnv?: NodeJS.ProcessEnv
  overrideEnv?: NodeJS.ProcessEnv
}

export function createRuntimeEnv(
  options: CreateRuntimeEnvOptions,
): NodeJS.ProcessEnv {
  // Manifest env values are baked deployment defaults; the live execution
  // environment must override them, and explicit per-start overrides win over
  // everything. executionEnv exists as a test seam and defaults to the real
  // process env.
  return compactEnv({
    ...process.env,
    ...options.manifest.config.env,
    ...options.manifest.runtimes[options.runtimeName]?.env,
    ...(options.executionEnv ?? process.env),
    ...options.overrideEnv,
  })
}

function compactEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    result[key] = value
  }

  return Object.freeze(result)
}
