import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { NeemRuntimeDescriptor } from '../runtime-module.ts'
import { startNeemServer } from '../runtime/bootstrap.ts'

import runtime from '#neem/runtime'

export async function run(options: { setupProcessHandlers?: boolean } = {}) {
  const descriptor = runtime as NeemRuntimeDescriptor

  return await startNeemServer({
    config: descriptor.serverConfig,
    applicationsConfig: descriptor.applicationsConfig,
    workerConfig: {
      path: resolveRuntimePath(descriptor.workerPath),
      workerData: { moduleLoader: descriptor.moduleLoader },
    },
    mode: descriptor.mode,
    moduleLoader: descriptor.moduleLoader,
    setupProcessHandlers: options.setupProcessHandlers ?? true,
  })
}

function isDirectExecution() {
  const entrypointPath = process.argv[1]
  if (!entrypointPath) return false

  return pathToFileURL(resolve(entrypointPath)).href === import.meta.url
}

if (isDirectExecution()) {
  run().catch((error) => {
    throw error
  })
}

function resolveRuntimePath(path: string): string {
  if (path.startsWith('file:') || path.startsWith('node:')) {
    return path
  }

  if (isAbsolute(path)) {
    return path
  }

  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(path)) {
    return path
  }

  return new URL(path, import.meta.url).pathname
}
