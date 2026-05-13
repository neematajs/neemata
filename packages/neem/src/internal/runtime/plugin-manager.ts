import type {
  NeemArtifactOwner,
  NeemResolvedArtifact,
} from '../../public/artifact.ts'
import type {
  NeemPluginWorkerHandle,
  NeemPluginWorkerSpawnOptions,
  NeemPluginWorkers,
} from '../../public/plugin.ts'
import type { NeemMode } from '../../public/runtime.ts'
import type { NeemScopedArtifactRegistry } from './artifact-registry.ts'
import type { NeemRuntimeSnapshot } from './snapshot.ts'
import { NeemRuntimeWorker } from './worker-runtime.ts'

export type NeemPluginWorkerManagerOptions = {
  mode: NeemMode
  name: string
  instanceId: number
  artifacts: NeemScopedArtifactRegistry
  configFile: string
  logger: NeemRuntimeSnapshot['logger']
  startupTimeoutMs?: number
  stopTimeoutMs?: number
  onFailure?: (
    error: Error,
    worker: NeemRuntimeWorker,
    manager: NeemPluginWorkerManager,
  ) => void | Promise<void>
}

export class NeemPluginWorkerManager implements NeemPluginWorkers {
  readonly owner: NeemArtifactOwner

  private readonly workers = new Map<string, NeemRuntimeWorker>()

  constructor(private readonly options: NeemPluginWorkerManagerOptions) {
    this.owner = {
      type: 'plugin',
      name: options.name,
      instanceId: options.instanceId,
    }
  }

  async spawn(
    options: NeemPluginWorkerSpawnOptions,
  ): Promise<NeemPluginWorkerHandle> {
    const artifact = this.resolveWorkerArtifact(options.artifact)
    const id = options.id ?? `${this.ownerKey()}:${options.name}`

    if (this.workers.has(id)) {
      throw new Error(`Plugin worker [${id}] already exists`)
    }

    const worker = new NeemRuntimeWorker({
      id,
      name: options.name,
      mode: this.options.mode,
      data: options.workerData ?? {},
      artifact,
      artifacts: this.options.artifacts.scope(this.owner).list(),
      configFile: this.options.configFile,
      logger: this.options.logger,
      startupTimeoutMs: this.options.startupTimeoutMs,
      stopTimeoutMs: this.options.stopTimeoutMs,
      onFailure: (error, failedWorker) =>
        this.options.onFailure?.(error, failedWorker, this),
    })

    this.workers.set(id, worker)
    this.options.logger.trace(
      {
        plugin: this.options.name,
        instanceId: this.options.instanceId,
        worker: id,
        artifactId: artifact.id,
      },
      'Starting Neem plugin worker',
    )

    try {
      await worker.start()
      this.options.logger.trace(
        {
          plugin: this.options.name,
          instanceId: this.options.instanceId,
          worker: id,
        },
        'Neem plugin worker started',
      )
      return worker
    } catch (error) {
      this.workers.delete(id)
      await worker.stop().catch(() => undefined)
      throw error
    }
  }

  async stop(workerId: string): Promise<boolean> {
    const worker = this.workers.get(workerId)
    if (!worker) return false

    this.workers.delete(workerId)
    this.options.logger.trace(
      {
        plugin: this.options.name,
        instanceId: this.options.instanceId,
        worker: workerId,
      },
      'Stopping Neem plugin worker',
    )
    await worker.stop()
    return true
  }

  list(): readonly NeemPluginWorkerHandle[] {
    return [...this.workers.values()]
  }

  async stopAll(): Promise<void> {
    const workers = [...this.workers.values()]
    this.workers.clear()
    this.options.logger.trace(
      {
        plugin: this.options.name,
        instanceId: this.options.instanceId,
        count: workers.length,
      },
      'Stopping Neem plugin workers',
    )
    await Promise.all(workers.map((worker) => worker.stop()))
  }

  private resolveWorkerArtifact(
    artifact: string | NeemResolvedArtifact,
  ): NeemResolvedArtifact {
    if (typeof artifact !== 'string') return artifact

    const resolved = this.options.artifacts.resolveFor(this.owner, artifact)
    if (!resolved) {
      throw new Error(
        `Plugin [${this.options.name}] worker artifact [${artifact}] was not found`,
      )
    }

    return resolved
  }

  private ownerKey(): string {
    return `plugin:${this.options.instanceId}:${this.options.name}`
  }
}
