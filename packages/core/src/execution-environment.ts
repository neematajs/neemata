import type { Container } from './container.ts'
import type { AnyInjectable, Dependant } from './injectables.ts'
import type { Logger } from './logger.ts'
import type { ExecutionEnvironmentPlugin } from './plugin.ts'
import type { HookTypes } from './types.ts'
import { Container as CoreContainer } from './container.ts'
import { Scope } from './enums.ts'
import { Hooks } from './hooks.ts'
import {
  CoreInjectables,
  getDepedencencyInjectable,
  provision,
} from './injectables.ts'
import { forkLogger } from './logger.ts'

export enum ExecutionEnvironmentLifecycleHook {
  BeforeInitialize = 'lifecycle:beforeInitialize',
  AfterInitialize = 'lifecycle:afterInitialize',
  BeforeDispose = 'lifecycle:beforeDispose',
  AfterDispose = 'lifecycle:afterDispose',
  Stop = 'lifecycle:stop',
  Start = 'lifecycle:start',
}

export interface ExecutionEnvironmentLifecycleRuntime {
  logger: Logger
  container: Container
}

export interface ExecutionEnvironmentLifecycleHookTypes extends HookTypes {
  [ExecutionEnvironmentLifecycleHook.BeforeInitialize]: (
    runtime: ExecutionEnvironmentLifecycleRuntime,
  ) => any
  [ExecutionEnvironmentLifecycleHook.AfterInitialize]: (
    runtime: ExecutionEnvironmentLifecycleRuntime,
  ) => any
  [ExecutionEnvironmentLifecycleHook.BeforeDispose]: (
    runtime: ExecutionEnvironmentLifecycleRuntime,
  ) => any
  [ExecutionEnvironmentLifecycleHook.AfterDispose]: (
    runtime: ExecutionEnvironmentLifecycleRuntime,
  ) => any
  [ExecutionEnvironmentLifecycleHook.Start]: () => any
  [ExecutionEnvironmentLifecycleHook.Stop]: () => any
}

export class ExecutionEnvironmentLifecycleHooks<
  HookTypes extends ExecutionEnvironmentLifecycleHookTypes =
    ExecutionEnvironmentLifecycleHookTypes,
> extends Hooks<HookTypes> {}

export type ExecutionEnvironmentOptions<
  HookTypes extends ExecutionEnvironmentLifecycleHookTypes =
    ExecutionEnvironmentLifecycleHookTypes,
> = {
  logger: Logger
  container?: Container
  label?: string
  lifecycleHooks?: ExecutionEnvironmentLifecycleHooks<HookTypes>['_']['config']
  plugins?: readonly ExecutionEnvironmentPlugin<HookTypes>[]
}

export class ExecutionEnvironment<
  HookTypes extends ExecutionEnvironmentLifecycleHookTypes =
    ExecutionEnvironmentLifecycleHookTypes,
> {
  readonly logger: Logger
  readonly container: Container
  readonly lifecycleHooks = new ExecutionEnvironmentLifecycleHooks<HookTypes>()

  constructor(options: ExecutionEnvironmentOptions<HookTypes>) {
    this.logger = options.label
      ? forkLogger(options.logger, options.label)
      : options.logger

    this.container = options.container
      ? options.container.fork(Scope.Global)
      : new CoreContainer({ logger: this.logger })

    this.container.provide([provision(CoreInjectables.logger, this.logger)])

    if (options.lifecycleHooks) {
      this.lifecycleHooks.addHooks(options.lifecycleHooks)
    }

    for (const plugin of options.plugins ?? []) {
      if (plugin.provisions) {
        this.container.provide([...plugin.provisions])
      }
      if (plugin.hooks) {
        this.lifecycleHooks.addHooks(plugin.hooks)
      }
    }
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
    try {
      await this.container.dispose()
    } finally {
      this.lifecycleHooks.removeAllHooks()
    }
  }
}
