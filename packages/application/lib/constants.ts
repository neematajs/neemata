export enum Scope {
  Global = 'Global',
  Connection = 'Connection',
  Call = 'Call',
  Transient = 'Transient',
}

export enum Hook {
  BeforeInitialize = 'BeforeInitialize',
  AfterInitialize = 'AfterInitialize',
  BeforeStart = 'BeforeStart',
  AfterStart = 'AfterStart',
  BeforeStop = 'BeforeStop',
  AfterStop = 'AfterStop',
  BeforeTerminate = 'BeforeTerminate',
  AfterTerminate = 'AfterTerminate',
  OnConnect = 'OnConnect',
  OnDisconnect = 'OnDisconnect',
}

export enum WorkerType {
  Api = 'Api',
  Task = 'Task',
}

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

export const kProcedure: unique symbol = Symbol.for('neemata:ProcedureKey')
export type kProcedure = typeof kProcedure

export const kProcedureSubscription: unique symbol = Symbol.for(
  'neemata:ProcedureSubscriptionKey',
)
export type kProcedureSubscription = typeof kProcedureSubscription

export const kProcedureMetadata: unique symbol = Symbol.for(
  'neemata:ProcedureMetadataKey',
)
export type kProcedureMetadata = typeof kProcedureMetadata

export const kService: unique symbol = Symbol.for('neemata:ServiceKey')
export type kService = typeof kService

export const kTask: unique symbol = Symbol.for('neemata:TaskKey')
export type kTask = typeof kTask

export const kSubscriptionResponse: unique symbol = Symbol.for(
  'neemata:SubscriptionResponseKey',
)
export type kSubscriptionResponse = typeof kSubscriptionResponse

export const kPlugin: unique symbol = Symbol.for('neemata:PluginKey')
export type kPlugin = typeof kPlugin

export const kTransportPlugin: unique symbol = Symbol.for(
  'neemata:TransportPluginKey',
)
export type kTransportPlugin = typeof kTransportPlugin
