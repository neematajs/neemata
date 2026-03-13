import { createLogger } from '@nmtjs/core'

import type { ApplicationRuntime } from '../types.ts'
import {
  createApplicationRuntime,
  isApplicationDefinition,
} from '../runtime/application.ts'

type ApplicationThreadRuntime = {
  type: 'application'
  name: string
  entrypoint: string
  options: unknown
}

type ModuleLoader = (entrypoint: string) => Promise<unknown>

export async function run(
  runtime: ApplicationThreadRuntime,
  mode: 'development' | 'production',
  loadModule: ModuleLoader,
): Promise<ApplicationRuntime> {
  const logger = createLogger(
    { pinoOptions: { level: mode === 'development' ? 'debug' : 'info' } },
    'NeemWorker',
  )

  if (runtime.type !== 'application') {
    throw new Error(`Unsupported runtime type: ${(runtime as any).type}`)
  }

  const loaded = (await loadModule(runtime.entrypoint)) as { default?: unknown }

  if (!isApplicationDefinition(loaded.default)) {
    throw new Error(`Invalid application definition: ${runtime.entrypoint}`)
  }

  const definition = loaded.default

  const applicationRuntime = await createApplicationRuntime(
    runtime.name,
    definition,
    mode,
    runtime.options,
  )

  ;(globalThis as any)._hotAccept = async (module: unknown) => {
    if (!applicationRuntime.reload) return

    const candidate = (module as { default?: unknown })?.default
    if (!isApplicationDefinition(candidate)) {
      logger.warn('Ignoring HMR update with invalid application definition')
      return
    }

    await applicationRuntime.reload(candidate.definition)
  }

  return applicationRuntime
}
