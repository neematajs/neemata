import type { CallTypeProvider, TypeProvider } from '@nmtjs/common'

import { InjectableKey, ProviderKey, Scope } from './constants.ts'
import {
  type AnyInjectable,
  type Dependant,
  type Dependencies,
  type DependencyContext,
  type Injectable,
  type LazyInjectable,
  createFactoryInjectable,
  createLazyInjectable,
  createValueInjectable,
} from './container.ts'
import type { Async } from './types.ts'

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

export interface Provider<
  ProvidableTypeProvider extends TypeProvider = TypeProvider,
  ProvidableDeps extends Dependencies = Dependencies,
  ProvidableScope extends Scope = Scope,
> extends Dependant<ProvidableDeps> {
  options: LazyInjectable<ProvidableTypeProvider['input']>
  scope: ProvidableScope
  factory: ProvidableFactoryType<ProvidableTypeProvider, ProvidableDeps>
  dispose?: ProvidableDisposeType<ProvidableTypeProvider, ProvidableDeps>
  [ProviderKey]: ProvidableTypeProvider
}

export type AnyProvider = Provider<any, any, Scope>

export function provide<
  P extends AnyProvider,
  O extends P[ProviderKey]['input'],
>(
  provider: P,
  options: O | AnyInjectable<O>,
): Injectable<
  CallTypeProvider<P[ProviderKey], O>,
  P['dependencies'],
  P['scope']
> {
  const dependencies = { ...provider.dependencies }
  dependencies.options =
    InjectableKey in options ? options : createValueInjectable(options)
  return createFactoryInjectable({
    dependencies,
    scope: provider.scope,
    factory: provider.factory as any,
    dispose: provider.dispose as any,
  })
}

export function withTypeProvider<P extends TypeProvider>() {
  return {
    createProvider<
      ProviderDeps extends Dependencies = {},
      ProviderScope extends Scope = Scope.Global,
    >({
      dependencies = {} as ProviderDeps,
      scope = Scope.Global as ProviderScope,
      factory,
      dispose,
    }: {
      dependencies?: ProviderDeps
      scope?: ProviderScope
      factory: ProvidableFactoryType<
        P,
        ProviderDeps & { options: LazyInjectable<P['input']> }
      >
      dispose?: ProvidableDisposeType<
        P,
        ProviderDeps & { options: LazyInjectable<P['input']> }
      >
    }): Provider<P, ProviderDeps, ProviderScope> {
      const options = createLazyInjectable<P['input']>()
      if ('options' in dependencies)
        throw new Error(
          '"options" is a reserved key for a provider dependencies',
        )
      return {
        options,
        scope,
        dependencies: { ...dependencies, options },
        factory: factory as any,
        dispose: dispose as any,
        [ProviderKey]: true as unknown as P,
      }
    },
  }
}
