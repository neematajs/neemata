import type {
  ExecutionEnvironmentLifecycleHooks,
  ExecutionEnvironmentLifecycleHookTypes,
} from './execution-environment.ts'
import type { Provision } from './injectables.ts'

export interface ExecutionEnvironmentPlugin<
  HookTypes extends ExecutionEnvironmentLifecycleHookTypes =
    ExecutionEnvironmentLifecycleHookTypes,
> {
  name: string
  provisions?: readonly Provision[]
  hooks?: ExecutionEnvironmentLifecycleHooks<HookTypes>['_']['config']
}

export function createPlugin<
  HookTypes extends ExecutionEnvironmentLifecycleHookTypes,
  const Plugin extends ExecutionEnvironmentPlugin<HookTypes>,
>(plugin: Plugin): Plugin {
  return plugin
}
