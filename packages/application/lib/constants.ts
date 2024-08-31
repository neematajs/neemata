export enum Scope {
  Global = 'Global',
  Connection = 'Connection',
  Call = 'Call',
  Transient = 'Transient',
}

export enum Hook {
  BeforeInitialize = 'BeforeInitialize',
  AfterInitialize = 'AfterInitialize',
  OnStartup = 'OnStartup',
  OnShutdown = 'OnShutdown',
  BeforeTerminate = 'BeforeTerminate',
  AfterTerminate = 'AfterTerminate',
  OnConnect = 'OnConnect',
  OnDisconnect = 'OnDisconnect',
}

export enum WorkerType {
  Api = 'Api',
  Task = 'Task',
}

export const OptionalDependencyKey: unique symbol = Symbol(
  'OptionalDependencyKey',
)
export type OptionalDependencyKey = typeof OptionalDependencyKey

export const InjectableKey: unique symbol = Symbol('InjectableKey')
export type InjectableKey = typeof InjectableKey

export const LazyInjectableKey: unique symbol = Symbol('LazyInjectableKey')
export type LazyInjectableKey = typeof LazyInjectableKey

export const ValueInjectableKey: unique symbol = Symbol('ValueInjectableKey')
export type ValueInjectableKey = typeof ValueInjectableKey

export const FactoryInjectableKey: unique symbol = Symbol(
  'FactoryInjectableKey',
)
export type FactoryInjectableKey = typeof FactoryInjectableKey

export const ProviderKey: unique symbol = Symbol('ProviderKey')
export type ProviderKey = typeof ProviderKey
