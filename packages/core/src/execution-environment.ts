import type { Container } from './container.ts'
import type { AnyInjectable, Dependant } from './injectables.ts'
import type { Logger } from './logger.ts'
import { Container as CoreContainer } from './container.ts'
import { Scope } from './enums.ts'
import {
  CoreInjectables,
  getDepedencencyInjectable,
  provision,
} from './injectables.ts'
import { forkLogger } from './logger.ts'

export type ExecutionEnvironmentOptions = {
  logger: Logger
  container?: Container
  label?: string
}

export class ExecutionEnvironment {
  readonly logger: Logger
  readonly container: Container

  constructor(options: ExecutionEnvironmentOptions) {
    this.logger = options.label
      ? forkLogger(options.logger, options.label)
      : options.logger

    this.container = options.container
      ? options.container.fork(Scope.Global)
      : new CoreContainer({ logger: this.logger })

    this.container.provide([provision(CoreInjectables.logger, this.logger)])
  }

  async initialize(dependants: Iterable<Dependant> = []): Promise<void> {
    const dependencies = new Set<AnyInjectable>()

    for (const dependant of dependants) {
      for (const dependency of Object.values(dependant.dependencies)) {
        dependencies.add(getDepedencencyInjectable(dependency))
      }
    }

    await this.container.initialize(dependencies)
  }

  async dispose(): Promise<void> {
    await this.container.dispose()
  }
}
