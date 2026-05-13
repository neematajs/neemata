import type { MessagePort } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MessageChannel } from 'node:worker_threads'

import type { Logger } from '@nmtjs/core'

import type { NeemResolvedArtifact } from '../../public/artifact.ts'
import type {
  NeemApplicationUpstream,
  NeemMode,
  NeemWorkerState,
} from '../../public/runtime.ts'
import type { NeemManagedWorkerController } from './managed-worker.ts'
import type {
  NeemRuntimeWorkerData,
  NeemRuntimeWorkerErrorMessage,
  NeemRuntimeWorkerMessage,
  NeemRuntimeWorkerReloadData,
} from './worker-protocol.ts'
import { createNeemChildLogger, createNeemDefaultLogger } from './logger.ts'
import { NeemManagedWorker } from './managed-worker.ts'

export type NeemRuntimeWorkerOptions = {
  id: string
  name: string
  mode: NeemMode
  data: unknown
  artifact: NeemResolvedArtifact
  artifacts: readonly NeemResolvedArtifact[]
  configFile: string
  logger?: Logger
  startupTimeoutMs?: number
  stopTimeoutMs?: number
  onFailure?: (error: Error, worker: NeemRuntimeWorker) => void | Promise<void>
}

export class NeemRuntimeWorker {
  readonly id: string
  readonly name: string
  readonly artifactId: string
  readonly artifact: NeemResolvedArtifact
  readonly port: MessagePort

  private readonly worker: NeemManagedWorker
  private upstreams: readonly NeemApplicationUpstream[] = []
  private reloadResolve: (() => void) | undefined
  private reloadReject: ((error: Error) => void) | undefined

  constructor(private readonly options: NeemRuntimeWorkerOptions) {
    this.id = options.id
    this.name = options.name
    this.artifactId = options.artifact.id
    this.artifact = options.artifact

    const channel = new MessageChannel()
    this.port = channel.port1

    const workerData: NeemRuntimeWorkerData = {
      mode: options.mode,
      name: options.name,
      data: options.data,
      artifact: options.artifact,
      artifacts: options.artifacts,
      configFile: options.configFile,
      port: channel.port2,
    }

    this.worker = new NeemManagedWorker({
      id: options.id,
      name: options.name,
      artifactId: options.artifact.id,
      entry: resolveRuntimeWorkerEntry(),
      workerData,
      workerOptions: { transferList: [channel.port2] },
      logger: createNeemChildLogger(
        options.logger ?? createNeemDefaultLogger(options.mode),
        options.name,
      ),
      startupTimeoutMs: options.startupTimeoutMs,
      stopTimeoutMs: options.stopTimeoutMs,
      onMessage: (message, controller) => {
        this.handleMessage(message as NeemRuntimeWorkerMessage, controller)
      },
      onFailure: (error) => options.onFailure?.(error, this),
    })
  }

  getState(): NeemWorkerState {
    return this.worker.getState()
  }

  getUpstreams(): readonly NeemApplicationUpstream[] {
    return this.upstreams
  }

  start(): Promise<void> {
    return this.worker.start()
  }

  async stop(): Promise<void> {
    this.rejectReload(new Error(`Worker [${this.name}] stopped during reload`))
    await this.worker.stop()
    this.port.close()
    this.upstreams = []
  }

  reload(data: NeemRuntimeWorkerReloadData): Promise<void> {
    if (this.reloadResolve) {
      throw new Error(`Worker [${this.name}] already has pending reload`)
    }

    const promise = new Promise<void>((resolve, reject) => {
      this.reloadResolve = resolve
      this.reloadReject = reject
    })

    try {
      this.worker.send({ type: 'reload', data })
    } catch (error) {
      this.rejectReload(
        error instanceof Error ? error : new Error(String(error)),
      )
    }

    return promise
  }

  private handleMessage(
    message: NeemRuntimeWorkerMessage,
    controller: NeemManagedWorkerController,
  ): void {
    if (message.type === 'ready') {
      this.upstreams = message.data.upstreams ?? []
      this.options.logger?.debug(
        { worker: this.name, upstreams: this.upstreams.length },
        'Neem runtime worker ready',
      )
      controller.markReady()
      return
    }

    if (message.type === 'reloaded') {
      this.upstreams = message.data.upstreams ?? []
      this.options.logger?.debug(
        { worker: this.name, upstreams: this.upstreams.length },
        'Neem runtime worker reloaded',
      )
      this.resolveReload()
      return
    }

    if (message.type === 'stopped') {
      this.options.logger?.debug(
        { worker: this.name },
        'Neem runtime worker stopped',
      )
      controller.markStopped()
      return
    }

    if (message.type === 'error') {
      const error = createRuntimeWorkerError(message)
      this.options.logger?.error(
        new Error(`Neem runtime worker [${this.name}] failed`, {
          cause: error,
        }),
      )
      this.rejectReload(error)
      controller.fail(error)
      return
    }

    controller.fail(new Error(`Unknown Neem runtime worker message`))
  }

  private resolveReload(): void {
    this.reloadResolve?.()
    this.reloadResolve = undefined
    this.reloadReject = undefined
  }

  private rejectReload(error: Error): void {
    this.reloadReject?.(error)
    this.reloadResolve = undefined
    this.reloadReject = undefined
  }
}

export function resolveRuntimeWorkerEntry(): URL {
  const sourceEntry = new URL(
    '../../../dist/internal/runtime/worker-entry.js',
    import.meta.url,
  )
  const distEntry = new URL('./worker-entry.js', import.meta.url)
  const entry = isSourceInternalFile(import.meta.url) ? sourceEntry : distEntry

  if (!existsSync(fileURLToPath(entry))) {
    throw new Error(
      `Neem runtime worker entry was not found at [${fileURLToPath(entry)}]`,
    )
  }

  return entry
}

function isSourceInternalFile(url: string): boolean {
  const file = fileURLToPath(url)
  return file.includes('/src/internal/')
}

function createRuntimeWorkerError(
  message: NeemRuntimeWorkerErrorMessage,
): Error {
  const error = new Error(message.data.message)
  error.name = message.data.name ?? error.name
  error.stack = message.data.stack
  return error
}
