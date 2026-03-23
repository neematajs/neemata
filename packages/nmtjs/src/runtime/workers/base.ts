import type { Provision } from '@nmtjs/core'
import { CoreInjectables, provision } from '@nmtjs/core'

import type { WorkerType } from '../enums.ts'
import type { BaseRuntimeOptions } from '../runtime.ts'
import type { ServerConfig } from '../server/config.ts'
import * as injectables from '../injectables.ts'
import { JobManager } from '../jobs/manager.ts'
import { BaseRuntime } from '../runtime.ts'
import { SubscriptionManager } from '../subscription/manager.ts'

export abstract class BaseWorkerRuntime extends BaseRuntime {
  subscriptionManager: SubscriptionManager
  jobManager?: JobManager

  constructor(
    readonly config: ServerConfig,
    options: BaseRuntimeOptions,
    readonly workerType: WorkerType,
  ) {
    super(options)

    this.subscriptionManager = new SubscriptionManager({
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
    const injections: Provision[] = [
      provision(CoreInjectables.logger, this.logger),
      provision(injectables.workerType, this.workerType),
      provision(
        injectables.publish,
        this.subscriptionManager.publish.bind(this.subscriptionManager),
      ),
      provision(
        injectables.subscribe,
        this.subscriptionManager.subscribe.bind(this.subscriptionManager),
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
