import type { Injection } from '@nmtjs/core'
import { CoreInjectables, provide } from '@nmtjs/core'

import type { BaseRuntimeOptions } from '../core/runtime.ts'
import type { WorkerType } from '../enums.ts'
import type { ServerConfig } from '../server/config.ts'
import { BaseRuntime } from '../core/runtime.ts'
import * as injectables from '../injectables.ts'
import { JobManager } from '../jobs/manager.ts'
import { PubSubManager } from '../pubsub/manager.ts'

export abstract class BaseWorkerRuntime extends BaseRuntime {
  pubsub: PubSubManager
  jobManager?: JobManager

  constructor(
    readonly config: ServerConfig,
    options: BaseRuntimeOptions,
    readonly workerType: WorkerType,
  ) {
    super(options)

    this.pubsub = new PubSubManager({
      logger: this.logger,
      container: this.container,
    })

    if (this.config.store) {
      this.jobManager = new JobManager(
        this.config.store,
        this.config.jobs ? Array.from(this.config.jobs.jobs.values()) : [],
      )
    }
  }

  async initialize(): Promise<void> {
    const injections: Injection[] = [
      provide(CoreInjectables.logger, this.logger),
      provide(injectables.workerType, this.workerType),
      provide(injectables.pubSubPublish, this.pubsub.publish.bind(this.pubsub)),
      provide(
        injectables.pubSubSubscribe,
        this.pubsub.subscribe.bind(this.pubsub),
      ),
    ]

    if (this.config.store) {
      injections.push(provide(injectables.storeConfig, this.config.store))
    }

    if (this.jobManager) {
      injections.push(
        provide(injectables.jobManager, this.jobManager.publicInstance),
      )
    }

    await this.container.provide(injections)
    await super.initialize()
  }

  protected async _initialize(): Promise<void> {
    await this.jobManager?.initialize()
  }

  protected async _dispose(): Promise<void> {
    await this.jobManager?.terminate()
  }
}
