import { resolve } from 'node:path'

import type { Logger } from '@nmtjs/core'

import type { NeemArtifactRegistry } from '../../public/artifact.ts'
import type { NeemMode, NeemRuntimeUpstream } from '../../public/runtime.ts'
import type { NeemBuildManifest } from '../build/manifest.ts'
import type { NeemHostHooks } from '../runtime/hooks.ts'
import type { NeemProxyUpstreamSnapshot } from '../runtime/proxy.ts'
import type {
  NeemStartedRuntimePool,
  NeemStartedRuntimeThread,
} from '../runtime/runtime.ts'
import type {
  NeemRuntimeServer,
  NeemRuntimeServerHealth,
} from '../runtime/server.ts'
import { NEEM_MANIFEST_FILE } from '../build/manifest.ts'
import { NeemRuntimeServer as RuntimeServer } from '../runtime/server.ts'
import { loadBuiltRuntimeSnapshot } from '../runtime/snapshot-loader.ts'

export type NeemStartOptions = {
  outDir?: string
  cwd?: string
  mode?: NeemMode
  runtimes?: readonly string[]
  failOnWorkerError?: boolean
  hooks?: NeemHostHooks
  runtimeWorkerEntry?: string | URL
  signal?: AbortSignal
}

export type NeemStartedHost = {
  mode: NeemMode
  outDir: string
  manifestFile: string
  manifest: NeemBuildManifest
  artifacts: NeemArtifactRegistry
  closed: Promise<void>
  getRuntimeWorkers: () => IterableIterator<NeemStartedRuntimeThread>
  getRuntimeWorkerPools: () => IterableIterator<NeemStartedRuntimePool>
  getHealth: () => NeemRuntimeServerHealth
  getUpstreams: () => readonly NeemRuntimeUpstream[]
  getProxyUpstreams: () => IterableIterator<NeemProxyUpstreamSnapshot>
  stop: () => Promise<void>
}

export async function startNeem(
  options: NeemStartOptions = {},
): Promise<NeemStartedHost> {
  const cwd = options.cwd ?? process.cwd()
  const mode = options.mode ?? 'production'
  const failOnWorkerError = options.failOnWorkerError ?? mode === 'production'
  const outDir = resolve(cwd, options.outDir ?? 'dist')
  const manifestFile = resolve(outDir, NEEM_MANIFEST_FILE)
  const snapshot = await loadBuiltRuntimeSnapshot({
    cwd,
    outDir,
    mode,
    runtimes: options.runtimes,
    runtimeWorkerEntry: options.runtimeWorkerEntry,
  })
  snapshot.logger.info({ outDir, mode }, 'Starting Neem from built output')
  snapshot.logger.debug(
    {
      manifestFile,
      runtimes: Object.keys(snapshot.manifest.runtimes ?? {}),
      artifacts: snapshot.artifacts.list().length,
    },
    'Neem runtime snapshot loaded',
  )
  const server = new RuntimeServer({
    snapshot,
    failOnWorkerError,
    hooks: options.hooks,
  })
  const host = createStartedHost({
    mode,
    outDir,
    manifestFile,
    manifest: snapshot.manifest,
    artifacts: snapshot.artifacts,
    logger: snapshot.logger,
    server,
  })

  if (options.signal?.aborted) {
    await host.stop()
    return host
  }

  const onAbort = () => {
    void host.stop()
  }

  options.signal?.addEventListener('abort', onAbort, { once: true })
  host.closed
    .finally(() => {
      options.signal?.removeEventListener('abort', onAbort)
    })
    .catch(() => {})

  try {
    await server.start()
    snapshot.logger.info('Neem runtime started')
  } catch (error) {
    await host.fail(error instanceof Error ? error : new Error(String(error)))
    throw error
  }

  return host
}

function createStartedHost(options: {
  mode: NeemMode
  outDir: string
  manifestFile: string
  manifest: NeemBuildManifest
  artifacts: NeemArtifactRegistry
  logger: Logger
  server: NeemRuntimeServer
}) {
  let stopPromise: Promise<void> | undefined
  let closedSettled = false
  let closeResolve!: () => void
  let closeReject!: (error: Error) => void
  let failure: Error | undefined

  const closed = new Promise<void>((resolve, reject) => {
    closeResolve = resolve
    closeReject = reject
  })
  closed.catch(() => {})

  const settleClosed = (error?: Error) => {
    if (closedSettled) return
    closedSettled = true
    if (error) closeReject(error)
    else closeResolve()
  }

  const stop = async () => {
    if (!stopPromise) {
      options.logger.info('Stopping Neem runtime')
      stopPromise = options.server
        .stop()
        .catch((error) => {
          failure ??= error instanceof Error ? error : new Error(String(error))
        })
        .finally(() => {
          options.logger.info('Neem runtime stopped')
          settleClosed(failure)
        })
    }
    return stopPromise
  }

  const host = {
    mode: options.mode,
    outDir: options.outDir,
    manifestFile: options.manifestFile,
    manifest: options.manifest,
    artifacts: options.artifacts,
    closed,
    getRuntimeWorkers() {
      return options.server.getRuntimeWorkers()
    },
    getRuntimeWorkerPools() {
      return options.server.getRuntimeWorkerPools()
    },
    getHealth() {
      return options.server.getHealth()
    },
    getUpstreams() {
      const upstreams: NeemRuntimeUpstream[] = []
      for (const worker of options.server.getRuntimeWorkers()) {
        upstreams.push(...worker.getUpstreams())
      }
      return upstreams
    },
    getProxyUpstreams() {
      return options.server.getProxyUpstreams()
    },
    stop,
    async fail(error: Error) {
      failure ??= error
      await stop()
    },
  }

  options.server.options.onFailure = (error) => {
    options.logger.error(new Error('Neem runtime failed', { cause: error }))
    void host.fail(error)
  }

  return host
}
