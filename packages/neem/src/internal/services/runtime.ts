import { resolve } from 'node:path'

import type { NeemMode, NeemRuntimeServerHealth } from '../../public/runtime.ts'
import type { RuntimeEvent } from './protocol.ts'
import { HostController } from '../host/controller.ts'
import { readManifest, selectManifestRuntimes } from '../manifest/manifest.ts'
import { createRuntimeSnapshot } from '../manifest/snapshot.ts'
import { createHostHooks } from '../plugins/hooks.ts'
import { resolveManifestLogger } from '../shared/logger.ts'
import { serializeError } from '../shared/utils.ts'

export type RuntimeServiceOptions = {
  mode: NeemMode
  outDir: string
  manifestFile: string
  runtimes?: readonly string[]
  emit: (event: RuntimeEvent) => void
}

export class RuntimeService {
  private controller: HostController | undefined
  private readonly hooks = createHostHooks()
  private mode: NeemMode | undefined
  private outDir: string | undefined
  private runtimes: readonly string[] | undefined

  async start(
    options: RuntimeServiceOptions,
  ): Promise<NeemRuntimeServerHealth> {
    this.mode = options.mode
    this.outDir = options.outDir
    this.runtimes = options.runtimes
    const snapshot = await this.loadSnapshot(options.manifestFile)
    snapshot.logger.info(
      {
        mode: options.mode,
        outDir: options.outDir,
        manifestFile: options.manifestFile,
        runtimes: Object.keys(snapshot.manifest.runtimes),
      },
      'Neem runtime service starting',
    )
    const controller = new HostController({
      snapshot,
      hooks: this.hooks,
      failOnWorkerError: true,
      recovery: { attempts: options.mode === 'production' ? 3 : 1 },
      onFailure: (error) => {
        options.emit({ type: 'error', error: serializeError(error) })
      },
    })
    this.controller = controller
    await controller.start()
    const health = controller.getHealth()
    snapshot.logger.info(
      { ready: health.ready, revision: health.revision },
      'Neem runtime service ready',
    )
    options.emit({ type: 'ready', health })
    return health
  }

  async reload(manifestFile: string): Promise<NeemRuntimeServerHealth> {
    const controller = this.requireController()
    const snapshot = await this.loadSnapshot(manifestFile)
    snapshot.logger.debug({ manifestFile }, 'Neem runtime service reloading')
    await controller.reload(snapshot)
    return controller.getHealth()
  }

  async reloadRuntime(
    runtimeName: string,
    manifestFile: string,
  ): Promise<NeemRuntimeServerHealth> {
    const controller = this.requireController()
    const snapshot = await this.loadSnapshot(manifestFile)
    snapshot.logger.debug(
      { manifestFile, runtimeName },
      'Neem runtime service reloading runtime',
    )
    await controller.reloadRuntime(runtimeName, snapshot)
    return controller.getHealth()
  }

  async stop(): Promise<void> {
    const controller = this.controller
    this.controller = undefined
    await controller?.stop()
  }

  getHealth(): NeemRuntimeServerHealth {
    return this.requireController().getHealth()
  }

  private async loadSnapshot(manifestFile: string) {
    const outDir = this.outDir ?? resolve(manifestFile, '..')
    const mode = this.mode ?? 'production'
    const manifest = selectManifestRuntimes(
      await readManifest(manifestFile),
      this.runtimes,
    )
    const logger = await resolveManifestLogger(manifest.config.logger, {
      mode,
      outDir,
    })

    return createRuntimeSnapshot({
      mode,
      outDir,
      manifest,
      manifestFile,
      logger,
    })
  }

  private requireController(): HostController {
    if (!this.controller) throw new Error('Neem runtime service is not started')
    return this.controller
  }
}
