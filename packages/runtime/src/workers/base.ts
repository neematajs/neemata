import type { BaseRuntimeOptions } from '../core/runtime.ts'
import type { ServerConfig } from '../server/config.ts'
import { BaseRuntime } from '../core/runtime.ts'
import * as injectables from '../injectables.ts'
import { JobManager } from '../jobs/manager.ts'
import { PubSub } from '../pubsub/index.ts'

export abstract class BaseWorkerRuntime extends BaseRuntime {
  pubsub: PubSub
  jobManager: JobManager

  constructor(
    readonly config: ServerConfig,
    readonly options: BaseRuntimeOptions,
  ) {
    super(options)

    this.pubsub = new PubSub({ logger: this.logger, container: this.container })
    this.jobManager = new JobManager(this.config.store)
  }

  protected async _initialize(): Promise<void> {
    this.container.provide(injectables.StoreConfig, this.config.store)
    this.container.provide(
      injectables.PubSubPublish,
      this.pubsub.publish.bind(this.pubsub),
    )
    this.container.provide(
      injectables.PubSubSubscribe,
      this.pubsub.subscribe.bind(this.pubsub),
    )
    this.container.provide(
      injectables.JobManager,
      this.jobManager.publicInstance,
    )
  }
}
