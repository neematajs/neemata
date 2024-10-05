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

export const OptionalDependencyKey: unique symbol = Symbol.for(
  'neemata:OptionalDependencyKey',
)
export type OptionalDependencyKey = typeof OptionalDependencyKey

export const InjectableKey: unique symbol = Symbol.for('neemata:InjectableKey')
export type InjectableKey = typeof InjectableKey

export const LazyInjectableKey: unique symbol = Symbol.for(
  'neemata:LazyInjectableKey',
)
export type LazyInjectableKey = typeof LazyInjectableKey

export const ValueInjectableKey: unique symbol = Symbol.for(
  'neemata:ValueInjectableKey',
)
export type ValueInjectableKey = typeof ValueInjectableKey

export const FactoryInjectableKey: unique symbol = Symbol.for(
  'neemata:FactoryInjectableKey',
)
export type FactoryInjectableKey = typeof FactoryInjectableKey

export const ProviderKey: unique symbol = Symbol.for('neemata:ProviderKey')
export type ProviderKey = typeof ProviderKey

export const ProcedureKey: unique symbol = Symbol.for('neemata:ProcedureKey')
export type ProcedureKey = typeof ProcedureKey

export const ProcedureSubscriptionKey: unique symbol = Symbol.for(
  'neemata:ProcedureSubscriptionKey',
)
export type ProcedureSubscriptionKey = typeof ProcedureSubscriptionKey

export const ProcedureMetadataKey: unique symbol = Symbol.for(
  'neemata:ProcedureMetadataKey',
)
export type ProcedureMetadataKey = typeof ProcedureMetadataKey

export const ServiceKey: unique symbol = Symbol.for('neemata:ServiceKey')
export type ServiceKey = typeof ServiceKey

export const TaskKey: unique symbol = Symbol.for('neemata:TaskKey')
export type TaskKey = typeof TaskKey

export const SubscriptionResponseKey: unique symbol = Symbol.for(
  'neemata:SubscriptionResponseKey',
)
export type SubscriptionResponseKey = typeof SubscriptionResponseKey
