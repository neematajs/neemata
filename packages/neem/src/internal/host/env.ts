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
  return compactEnv({
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
