import type { Logger } from '@nmtjs/core'

import type { NeemMode, NeemRuntimeServerHealth } from '../../shared/types.ts'
import type { RuntimeEvent } from './protocol.ts'
import { HostController } from '../host/controller.ts'
import { resolveManifestLogger } from '../logger.ts'
import {
  assertManifestFilesExist,
  readManifest,
  selectManifestRuntimes,
} from '../manifest/manifest.ts'
import { createRuntimeSnapshot } from '../manifest/snapshot.ts'
import { serializeError } from '../utils.ts'

export type RuntimeServiceOptions = {
  mode: NeemMode
  outDir: string
  env?: NodeJS.ProcessEnv
  runtimes?: readonly string[]
  emit: (event: RuntimeEvent) => void
}

export class RuntimeService {
  private controller: HostController | undefined
  private logger: Logger | undefined

  constructor(private readonly options: RuntimeServiceOptions) {}

  async start(manifestFile: string): Promise<NeemRuntimeServerHealth> {
    const { mode, outDir, emit } = this.options
    const snapshot = await this.loadSnapshot(manifestFile)
    this.logger = snapshot.logger
    snapshot.logger.info('Neem runtime service starting')
    snapshot.logger.trace(
      {
        mode,
        outDir,
        manifestFile,
        runtimes: Object.keys(snapshot.manifest.runtimes),
      },
      'Neem runtime service options',
    )
    const controller = new HostController({
      snapshot,
      // Production keeps the built-in recovery policy; a dev session retries
      // once so a broken edit surfaces immediately.
      recovery: mode === 'production' ? undefined : { attempts: 1 },
      onFailure: (error) =>
        emit({ type: 'error', error: serializeError(error) }),
    })
    this.controller = controller
    await controller.start()
    const health = controller.getHealth()
    snapshot.logger.info('Neem runtime service ready')
    snapshot.logger.trace(
      { ready: health.ready, revision: health.revision },
      'Neem runtime service health',
    )
    emit({ type: 'ready', health })
    return health
  }

  async reloadRuntime(
    runtimeName: string,
    manifestFile: string,
  ): Promise<NeemRuntimeServerHealth> {
    const controller = this.requireController()
    const snapshot = await this.loadSnapshot(manifestFile)
    snapshot.logger.debug(
      `Neem runtime service reloading runtime ${runtimeName}`,
    )
    snapshot.logger.trace(
      { manifestFile, runtimeName },
      'Neem runtime service runtime reload options',
    )
    await controller.reloadRuntime(runtimeName, snapshot)
    return controller.getHealth()
  }

  async stop(): Promise<void> {
    const controller = this.controller
    this.controller = undefined
    this.logger?.debug('Neem runtime service stopping')
    await controller?.stop()
    this.logger?.debug('Neem runtime service stopped')
  }

  private async loadSnapshot(manifestFile: string) {
    const { mode, outDir, env, runtimes } = this.options
    const manifest = selectManifestRuntimes(
      await readManifest(manifestFile),
      runtimes,
    )
    await assertManifestFilesExist(outDir, manifest)
    const logger = await resolveManifestLogger(manifest.config.logger, {
      mode,
      outDir,
    })

    return createRuntimeSnapshot({
      mode,
      outDir,
      env,
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
