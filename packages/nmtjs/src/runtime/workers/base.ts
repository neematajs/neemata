import type { Injection } from '@nmtjs/core'
import { CoreInjectables, provision } from '@nmtjs/core'

import type { WorkerType } from '../enums.ts'
import type { BaseRuntimeOptions } from '../runtime.ts'
import type { ServerConfig } from '../server/config.ts'
import * as injectables from '../injectables.ts'
import { JobManager } from '../jobs/manager.ts'
import { PubSubManager } from '../pubsub/manager.ts'
import { BaseRuntime } from '../runtime.ts'

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
      provision(CoreInjectables.logger, this.logger),
      provision(injectables.workerType, this.workerType),
      provision(
        injectables.pubSubPublish,
        this.pubsub.publish.bind(this.pubsub),
      ),
      provision(
        injectables.pubSubSubscribe,
        this.pubsub.subscribe.bind(this.pubsub),
      ),
    ]

    if (this.config.store) {
      injections.push(provision(injectables.storeConfig, this.config.store))
    }

    if (this.jobManager) {
      injections.push(
        provision(injectables.jobManager, this.jobManager.publicInstance),
      )
    }

    this.container.provide(injections)
    await super.initialize()
  }

  protected async _initialize(): Promise<void> {
    await this.jobManager?.initialize()
  }

  protected async _dispose(): Promise<void> {
    await this.jobManager?.terminate()
  }
}
