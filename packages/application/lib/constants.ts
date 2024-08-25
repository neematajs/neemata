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

export const OptionalDependency: unique symbol = Symbol('OptionalDependency')
export type OptionalDependency = typeof OptionalDependency

export const IsProvider: unique symbol = Symbol('IsProvider')
export type IsProvider = typeof IsProvider
