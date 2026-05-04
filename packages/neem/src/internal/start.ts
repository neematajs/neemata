import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

import type {
  NeemArtifactRegistry,
  NeemResolvedArtifact,
} from '../public/artifact.ts'
import type { NeemConfig } from '../public/config.ts'
import type {
  NeemApplicationUpstream,
  NeemMode,
  NeemWorkerState,
} from '../public/runtime.ts'
import type {
  NeemAppWorkerData,
  NeemAppWorkerErrorMessage,
  NeemAppWorkerMessage,
} from './app-worker-protocol.ts'
import type {
  NeemBuildManifest,
  NeemBuildManifestArtifact,
} from './manifest.ts'
import { NEEM_MANIFEST_FILE, NEEM_MANIFEST_SCHEMA_VERSION } from './manifest.ts'

export type NeemStartOptions = {
  outDir?: string
  cwd?: string
  mode?: NeemMode
  failOnWorkerError?: boolean
  signal?: AbortSignal
}

export type NeemStartedAppWorker = {
  appName: string
  threadIndex: number
  artifact: NeemResolvedArtifact
  getState: () => NeemWorkerState
  getUpstreams: () => readonly NeemApplicationUpstream[]
  stop: () => Promise<void>
}

export type NeemStartedHost = {
  mode: NeemMode
  outDir: string
  manifestFile: string
  manifest: NeemBuildManifest
  artifacts: NeemArtifactRegistry
  closed: Promise<void>
  getWorkers: () => readonly NeemStartedAppWorker[]
  getUpstreams: () => readonly NeemApplicationUpstream[]
  stop: () => Promise<void>
}

type EntryModule<T> = { default: T }

export async function startNeem(
  options: NeemStartOptions = {},
): Promise<NeemStartedHost> {
  const cwd = options.cwd ?? process.cwd()
  const mode = options.mode ?? 'production'
  const failOnWorkerError = options.failOnWorkerError ?? mode === 'production'
  const outDir = resolve(cwd, options.outDir ?? 'dist')
  const manifestFile = resolve(outDir, NEEM_MANIFEST_FILE)
  const manifest = await readManifest(manifestFile)
  const config = await importDefault<NeemConfig>(
    resolve(outDir, manifest.config.file),
  )
  const artifacts = createArtifactRegistry(
    resolveManifestArtifacts(outDir, manifest),
  )

  const appWorkers = createAppWorkers({
    mode,
    outDir,
    manifest,
    config,
    artifacts,
  })
  const host = createStartedHost({
    mode,
    outDir,
    manifestFile,
    manifest,
    artifacts,
    workers: appWorkers,
  })

  for (const worker of appWorkers) {
    worker.onFailure = (error) => {
      if (failOnWorkerError) {
        void host.fail(error)
      }
    }
  }

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
    await Promise.all(appWorkers.map((worker) => worker.start()))
  } catch (error) {
    await host.fail(normalizeError(error))
    throw error
  }

  return host
}

async function readManifest(manifestFile: string): Promise<NeemBuildManifest> {
  const raw = JSON.parse(await readFile(manifestFile, 'utf8')) as unknown
  if (!isManifest(raw)) {
    throw new Error(`Invalid Neem manifest at [${manifestFile}]`)
  }

  return raw
}

function isManifest(value: unknown): value is NeemBuildManifest {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as NeemBuildManifest).schemaVersion ===
        NEEM_MANIFEST_SCHEMA_VERSION &&
      typeof (value as NeemBuildManifest).config?.file === 'string' &&
      typeof (value as NeemBuildManifest).apps === 'object' &&
      Array.isArray((value as NeemBuildManifest).plugins),
  )
}

function resolveManifestArtifacts(
  outDir: string,
  manifest: NeemBuildManifest,
): NeemResolvedArtifact[] {
  const artifacts: NeemResolvedArtifact[] = []

  for (const app of Object.values(manifest.apps)) {
    artifacts.push(resolveManifestArtifact(outDir, app.entry))
  }

  for (const plugin of manifest.plugins) {
    artifacts.push(resolveManifestArtifact(outDir, plugin.entry))
    for (const artifact of plugin.artifacts) {
      artifacts.push(resolveManifestArtifact(outDir, artifact))
    }
  }

  return artifacts
}

function resolveManifestArtifact(
  outDir: string,
  artifact: NeemBuildManifestArtifact,
): NeemResolvedArtifact {
  return {
    id: artifact.id,
    kind: artifact.kind as NeemResolvedArtifact['kind'],
    owner: artifact.owner,
    file: resolve(outDir, artifact.file),
    outDir: resolve(outDir, artifact.outDir),
  }
}

function createArtifactRegistry(
  artifacts: readonly NeemResolvedArtifact[],
): NeemArtifactRegistry {
  const byId = new Map<string, NeemResolvedArtifact>()
  for (const artifact of artifacts) {
    if (!byId.has(artifact.id)) byId.set(artifact.id, artifact)
  }

  return Object.freeze({
    resolve(id: string) {
      return byId.get(id)
    },
    list() {
      return artifacts
    },
  })
}

function createAppWorkers(options: {
  mode: NeemMode
  outDir: string
  manifest: NeemBuildManifest
  config: NeemConfig
  artifacts: NeemArtifactRegistry
}): NeemAppWorker[] {
  const workers: NeemAppWorker[] = []

  for (const [appName, appManifest] of Object.entries(options.manifest.apps)) {
    const appConfig = options.config.apps[appName]
    if (!appConfig) {
      throw new Error(`Config for app [${appName}] is missing`)
    }

    const appArtifact = resolveManifestArtifact(
      options.outDir,
      appManifest.entry,
    )
    appConfig.threads.forEach((threadOptions, threadIndex) => {
      workers.push(
        new NeemAppWorker({
          mode: options.mode,
          appName,
          threadIndex,
          threadOptions,
          appArtifact,
          artifacts: options.artifacts.list(),
        }),
      )
    })
  }

  return workers
}

function createStartedHost(options: {
  mode: NeemMode
  outDir: string
  manifestFile: string
  manifest: NeemBuildManifest
  artifacts: NeemArtifactRegistry
  workers: NeemAppWorker[]
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

  const stopWorkers = async () => {
    stopPromise ??= Promise.all(options.workers.map((worker) => worker.stop()))
      .then(() => undefined)
      .finally(() => {
        settleClosed(failure)
      })
    return stopPromise
  }

  const host = {
    mode: options.mode,
    outDir: options.outDir,
    manifestFile: options.manifestFile,
    manifest: options.manifest,
    artifacts: options.artifacts,
    closed,
    getWorkers() {
      return options.workers
    },
    getUpstreams() {
      return options.workers.flatMap((worker) => worker.getUpstreams())
    },
    stop: stopWorkers,
    async fail(error: Error) {
      failure ??= error
      await stopWorkers()
    },
  }

  return host
}

class NeemAppWorker implements NeemStartedAppWorker {
  readonly appName: string
  readonly threadIndex: number
  readonly artifact: NeemResolvedArtifact
  onFailure?: (error: Error) => void

  private worker: Worker | undefined
  private state: NeemWorkerState = 'idle'
  private upstreams: readonly NeemApplicationUpstream[] = []
  private readyResolve: (() => void) | undefined
  private readyReject: ((error: Error) => void) | undefined
  private exitResolve: (() => void) | undefined
  private exitPromise: Promise<void> | undefined
  private stopping = false

  constructor(
    private readonly data: {
      appName: string
      mode: NeemMode
      threadIndex: number
      threadOptions: unknown
      appArtifact: NeemResolvedArtifact
      artifacts: readonly NeemResolvedArtifact[]
    },
  ) {
    this.appName = data.appName
    this.threadIndex = data.threadIndex
    this.artifact = data.appArtifact
  }

  getState() {
    return this.state
  }

  getUpstreams() {
    return this.upstreams
  }

  start(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve()
    if (this.worker) {
      throw new Error(
        `App worker [${this.appName}:${this.threadIndex}] already started`,
      )
    }

    this.state = 'starting'
    const workerData: NeemAppWorkerData = {
      appName: this.data.appName,
      mode: this.data.mode,
      threadIndex: this.data.threadIndex,
      threadOptions: this.data.threadOptions,
      appArtifact: this.data.appArtifact,
      artifacts: this.data.artifacts,
    }

    const worker = new Worker(resolveAppWorkerEntry(), { workerData })
    this.worker = worker
    this.exitPromise = new Promise<void>((resolve) => {
      this.exitResolve = resolve
    })

    worker.on('message', (message: NeemAppWorkerMessage) => {
      this.handleMessage(message)
    })
    worker.on('error', (error) => {
      this.handleError(error)
    })
    worker.on('exit', (code) => {
      this.handleExit(code)
    })

    return new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
  }

  async stop(): Promise<void> {
    if (!this.worker || this.state === 'stopped') return

    this.stopping = true
    this.state = 'stopping'
    try {
      this.worker.postMessage({ type: 'stop' })
    } catch {}

    try {
      await Promise.race([
        this.exitPromise,
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ])
    } finally {
      if (this.worker) {
        await this.worker.terminate()
      }
      this.worker = undefined
      this.state = 'stopped'
    }
  }

  private handleMessage(message: NeemAppWorkerMessage) {
    if (message.type === 'ready') {
      this.state = 'ready'
      this.upstreams = message.data.upstreams ?? []
      this.readyResolve?.()
      this.clearReadyHandlers()
      return
    }

    if (message.type === 'error') {
      this.handleError(deserializeWorkerError(message.data))
      return
    }

    if (message.type === 'stopped') {
      this.state = 'stopped'
    }
  }

  private handleError(error: Error) {
    if (this.state === 'starting') {
      this.state = 'failed'
      this.readyReject?.(error)
      this.clearReadyHandlers()
      return
    }

    if (this.stopping || this.state === 'stopped') return

    this.state = 'failed'
    this.onFailure?.(error)
  }

  private handleExit(code: number) {
    this.exitResolve?.()

    if (this.stopping || this.state === 'stopped') {
      this.state = 'stopped'
      return
    }

    const error = new Error(
      `App worker [${this.appName}:${this.threadIndex}] exited with code [${code}]`,
    )

    if (this.state === 'starting') {
      this.state = 'failed'
      this.readyReject?.(error)
      this.clearReadyHandlers()
      return
    }

    if (this.state === 'ready') {
      this.state = 'failed'
      this.onFailure?.(error)
    }
  }

  private clearReadyHandlers() {
    this.readyResolve = undefined
    this.readyReject = undefined
  }
}

async function importDefault<T>(file: string): Promise<T> {
  return ((await import(pathToFileURL(file).href)) as EntryModule<T>).default
}

function resolveAppWorkerEntry(): URL {
  const currentFile = fileURLToPath(import.meta.url)
  const entry =
    currentFile.endsWith('/src/internal/start.ts') ||
    currentFile.endsWith('\\src\\internal\\start.ts')
      ? new URL('../../dist/internal/app-worker-entry.js', import.meta.url)
      : new URL('./app-worker-entry.js', import.meta.url)

  if (!existsSync(fileURLToPath(entry))) {
    throw new Error(
      `Neem app worker entry was not found at [${fileURLToPath(entry)}]. Run the @nmtjs/neem package build before starting Neem from source.`,
    )
  }

  return entry
}

function deserializeWorkerError(
  data: NeemAppWorkerErrorMessage['data'],
): Error {
  const error = new Error(data.message)
  error.name = data.name ?? error.name
  error.stack = data.stack
  return error
}

function normalizeError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(String(value))
}
