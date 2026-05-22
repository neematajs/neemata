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
import type { NeemHostHooks } from './hooks.ts'
import type { NeemRuntimeSnapshot } from './snapshot.ts'
import { callNeemHostHook } from './hooks.ts'
import { NeemRuntimeWorker } from './worker-runtime.ts'

export type NeemPluginWorkerManagerOptions = {
  mode: NeemMode
  name: string
  instanceId: number
  artifacts: NeemScopedArtifactRegistry
  configFile: string
  runtimeWorkerEntry?: string | URL
  hooks: NeemHostHooks
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
      runtimeWorkerEntry: this.options.runtimeWorkerEntry,
      logger: this.options.logger,
      startupTimeoutMs: this.options.startupTimeoutMs,
      stopTimeoutMs: this.options.stopTimeoutMs,
      onFailure: (error, failedWorker) => {
        void this.callWorkerHook(failedWorker, 'worker:fail', error)
        return this.options.onFailure?.(error, failedWorker, this)
      },
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
      await this.callWorkerHook(worker, 'worker:start')
      await worker.start()
      await this.callWorkerHook(worker, 'worker:ready')
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
      await this.callWorkerHook(
        worker,
        'worker:fail',
        error instanceof Error ? error : new Error(String(error)),
      )
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
    await this.callWorkerHook(worker, 'worker:stop')
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
    await Promise.all(
      workers.map((worker) => this.callWorkerHook(worker, 'worker:stop')),
    )
  }

  private callWorkerHook(
    worker: NeemRuntimeWorker,
    name: 'worker:start' | 'worker:ready' | 'worker:stop',
  ): Promise<void>
  private callWorkerHook(
    worker: NeemRuntimeWorker,
    name: 'worker:fail',
    error: Error,
  ): Promise<void>
  private callWorkerHook(
    worker: NeemRuntimeWorker,
    name: 'worker:start' | 'worker:ready' | 'worker:stop' | 'worker:fail',
    error?: Error,
  ): Promise<void> {
    return callNeemHostHook(this.options.hooks, this.options.logger, name, {
      mode: this.options.mode,
      id: worker.id,
      name: worker.name,
      artifactId: worker.artifactId,
      owner: worker.artifact.owner,
      error,
    })
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
