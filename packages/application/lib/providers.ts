import type { CallTypeProvider, TypeProvider } from '@nmtjs/common'
import { Scope } from './constants.ts'
import {
  type AnyInjectable,
  type Dependant,
  type Dependencies,
  type DependencyContext,
  Injectable,
} from './container.ts'
import type { Async } from './types.ts'
import { merge } from './utils/functions.ts'

type ProvidableFactoryType<
  ProvidableTypeProvider extends TypeProvider = TypeProvider,
  ProvidableDeps extends Dependencies = {},
> = (
  context: DependencyContext<ProvidableDeps> & {
    options: ProvidableTypeProvider['input']
  },
) => Async<ProvidableTypeProvider['output']>

type ProvidableDisposeType<
  ProvidableTypeProvider extends TypeProvider = TypeProvider,
  ProvidableDeps extends Dependencies = {},
> = (
  instance: ProvidableTypeProvider['output'],
  context: DependencyContext<ProvidableDeps> & {
    options: ProvidableTypeProvider['input']
  },
) => Async<void>

export interface ProvidableLike<
  ProvidableTypeProvider extends TypeProvider = TypeProvider,
  ProvidableDeps extends Dependencies = Dependencies,
  ProvidableScope extends Scope = Scope,
> extends Dependant<ProvidableDeps> {
  $type: ProvidableTypeProvider
  scope: ProvidableScope
  factory: ProvidableFactoryType<ProvidableTypeProvider, ProvidableDeps>
  dispose?: ProvidableDisposeType<ProvidableTypeProvider, ProvidableDeps>
}

export type AnyProvider = Provider<any, any, Scope>

export class Provider<
  ProviderTypeProvider extends TypeProvider,
  ProviderDeps extends Dependencies = {},
  ProviderScope extends Scope = Scope.Global,
> implements ProvidableLike<ProviderTypeProvider, ProviderDeps, ProviderScope>
{
  $type!: ProviderTypeProvider
  dependencies: ProviderDeps = {} as ProviderDeps
  scope: ProviderScope = Scope.Global as ProviderScope
  factory!: ProvidableFactoryType<ProviderTypeProvider, ProviderDeps>
  dispose?: ProvidableDisposeType<ProviderTypeProvider, ProviderDeps>

  withScope<T extends Scope>(scope: T) {
    this.scope = scope as unknown as ProviderScope
    return this as unknown as Provider<ProviderTypeProvider, ProviderDeps, T>
  }

  withFactory(
    factory: ProvidableFactoryType<ProviderTypeProvider, ProviderDeps>,
  ) {
    this.factory = factory
    return this
  }

  withDispose(
    dispose: ProvidableDisposeType<ProviderTypeProvider, ProviderDeps>,
  ) {
    this.dispose = dispose
    return this
  }

  withDependencies<T extends Dependencies>(newDependencies: T) {
    this.dependencies = merge(this.dependencies, newDependencies)
    return this as unknown as Provider<
      ProviderTypeProvider,
      ProviderDeps & T,
      ProviderScope
    >
  }
}

export function provide<P extends AnyProvider, O extends P['$type']['input']>(
  provider: P,
  options: O | AnyInjectable<O>,
): Injectable<CallTypeProvider<P['$type'], O>, P['dependencies'], P['scope']> {
  const dependencies = { ...provider.dependencies }
  dependencies.options =
    options instanceof Injectable
      ? options
      : new Injectable().withValue(options)
  return new Injectable()
    .withScope(provider.scope)
    .withDependencies(dependencies)
    .withFactory(provider.factory as any)
    .withDispose(provider.dispose as any)
}
