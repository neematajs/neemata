export const kProcedure: unique symbol = Symbol.for('neemata:ProcedureKey')
export type kProcedure = typeof kProcedure

export const kDefaultProcedure: unique symbol = Symbol.for(
  'neemata:DefaultProcedureKey',
)
export type kDefaultProcedure = typeof kDefaultProcedure

export const kRouter: unique symbol = Symbol.for('neemata:RouterKey')
export type kRouter = typeof kRouter

export const kRootRouter: unique symbol = Symbol.for('neemata:RootRouterKey')
export type kRootRouter = typeof kRootRouter

export const kMiddleware: unique symbol = Symbol.for('neemata:MiddlewareKey')
export type kMiddleware = typeof kMiddleware

export const kGuard: unique symbol = Symbol.for('neemata:GuardKey')
export type kGuard = typeof kGuard

export const kFilter: unique symbol = Symbol.for('neemata:FilterKey')
export type kFilter = typeof kFilter
