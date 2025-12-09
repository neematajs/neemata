import { provide } from '@nmtjs/core'

import type { BaseRuntimeOptions } from '../core/runtime.ts'
import type { ServerConfig } from '../server/config.ts'
import { BaseRuntime } from '../core/runtime.ts'
import * as injectables from '../injectables.ts'
import { JobManager } from '../jobs/manager.ts'
import { PubSubManager } from '../pubsub/manager.ts'

export abstract class BaseWorkerRuntime extends BaseRuntime {
  pubsub: PubSubManager
  jobManager: JobManager

  constructor(
    readonly config: ServerConfig,
    options: BaseRuntimeOptions,
  ) {
    super(options)

    this.pubsub = new PubSubManager({
      logger: this.logger,
      container: this.container,
    })
    this.jobManager = new JobManager(this.config.store)
  }

  protected async _initialize(): Promise<void> {
    await this.jobManager.initialize()
    await this.container.provide([
      provide(injectables.storeConfig, this.config.store),
      provide(injectables.pubSubPublish, this.pubsub.publish.bind(this.pubsub)),
      provide(
        injectables.pubSubSubscribe,
        this.pubsub.subscribe.bind(this.pubsub),
      ),
      provide(injectables.jobManager, this.jobManager.publicInstance),
    ])
  }

  protected async _dispose(): Promise<void> {
    await this.jobManager.terminate()
  }
}
