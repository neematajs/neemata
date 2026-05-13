import { resolve } from 'node:path'

import type { Logger } from '@nmtjs/core'

import type { NeemArtifactRegistry } from '../../public/artifact.ts'
import type { NeemApplicationUpstream, NeemMode } from '../../public/runtime.ts'
import type { NeemBuildManifest } from '../build/manifest.ts'
import type {
  NeemStartedAppWorker,
  NeemStartedAppWorkerPool,
} from '../runtime/app.ts'
import type { NeemApplicationServer } from '../runtime/application-server.ts'
import type { NeemStartedPlugin } from '../runtime/plugin.ts'
import type { NeemProxyUpstreamSnapshot } from '../runtime/proxy.ts'
import { NEEM_MANIFEST_FILE } from '../build/manifest.ts'
import { NeemApplicationServer as RuntimeApplicationServer } from '../runtime/application-server.ts'
import { loadBuiltRuntimeSnapshot } from '../runtime/snapshot-loader.ts'

export type NeemStartOptions = {
  outDir?: string
  cwd?: string
  mode?: NeemMode
  failOnWorkerError?: boolean
  signal?: AbortSignal
}

export type NeemStartedHost = {
  mode: NeemMode
  outDir: string
  manifestFile: string
  manifest: NeemBuildManifest
  artifacts: NeemArtifactRegistry
  closed: Promise<void>
  getPlugins: () => readonly NeemStartedPlugin[]
  getWorkers: () => readonly NeemStartedAppWorker[]
  getWorkerPools: () => readonly NeemStartedAppWorkerPool[]
  getUpstreams: () => readonly NeemApplicationUpstream[]
  getProxyUpstreams: () => readonly NeemProxyUpstreamSnapshot[]
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
  const snapshot = await loadBuiltRuntimeSnapshot({ cwd, outDir, mode })
  snapshot.logger.info({ outDir, mode }, 'Starting Neem from built output')
  snapshot.logger.debug(
    {
      manifestFile,
      apps: Object.keys(snapshot.manifest.apps),
      plugins: snapshot.manifest.plugins.map((plugin) => plugin.name),
      artifacts: snapshot.artifacts.list().length,
    },
    'Neem runtime snapshot loaded',
  )
  const server = new RuntimeApplicationServer({ snapshot, failOnWorkerError })
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
  server: NeemApplicationServer
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
    getPlugins() {
      return options.server.getPlugins()
    },
    getWorkers() {
      return options.server.getAppWorkers()
    },
    getWorkerPools() {
      return options.server.getAppWorkerPools()
    },
    getUpstreams() {
      return options.server
        .getAppWorkers()
        .flatMap((worker) => worker.getUpstreams())
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
