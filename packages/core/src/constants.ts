export const kOptionalDependency: unique symbol = Symbol.for(
  'neemata:OptionalDependencyKey',
)
export type kOptionalDependency = typeof kOptionalDependency

export const kInjectable: unique symbol = Symbol.for('neemata:InjectableKey')
export type kInjectable = typeof kInjectable

export const kLazyInjectable: unique symbol = Symbol.for(
  'neemata:LazyInjectableKey',
)
export type kLazyInjectable = typeof kLazyInjectable

export const kValueInjectable: unique symbol = Symbol.for(
  'neemata:ValueInjectableKey',
)
export type kValueInjectable = typeof kValueInjectable

export const kFactoryInjectable: unique symbol = Symbol.for(
  'neemata:FactoryInjectableKey',
)
export type kFactoryInjectable = typeof kFactoryInjectable

export const kProvider: unique symbol = Symbol.for('neemata:ProviderKey')
export type kProvider = typeof kProvider

export const kPlugin: unique symbol = Symbol.for('neemata:PluginKey')
export type kPlugin = typeof kPlugin

export const kMetadata: unique symbol = Symbol.for('neemata:MetadataKey')
export type kMetadata = typeof kMetadata

export const kHook: unique symbol = Symbol.for('neemata:HookKey')
export type kHook = typeof kHook
