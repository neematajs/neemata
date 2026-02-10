import type { MaybePromise } from '@nmtjs/common'
import { tryCaptureStackTrace } from '@nmtjs/common'

import type { DisposeFn, InjectFn } from './container.ts'
import type { Logger } from './logger.ts'
import {
  kFactoryInjectable,
  kInjectable,
  kLazyInjectable,
  kOptionalDependency,
  kValueInjectable,
} from './constants.ts'
import { Scope } from './enums.ts'

const ScopeStrictness = {
  [Scope.Transient]: Number.NaN, // this should make it always fail to compare with other scopes
  [Scope.Global]: 1,
  [Scope.Connection]: 2,
  [Scope.Call]: 3,
}

export type DependencyOptional<T extends AnyInjectable = AnyInjectable> = {
  [kOptionalDependency]: any
  injectable: T
}

export type Depedency = DependencyOptional | AnyInjectable

export type Dependencies = Record<string, Depedency>

export type ResolveInjectableType<T extends AnyInjectable> =
  T extends Injectable<infer Type, any, any> ? Type : never

export interface Dependant<Deps extends Dependencies = Dependencies> {
  dependencies: Deps
  label?: string
  stack?: string
}

export type DependencyInjectable<T extends Depedency> = T extends AnyInjectable
  ? T
  : T extends DependencyOptional
    ? T['injectable']
    : never

export type DependencyContext<Deps extends Dependencies> = {
  readonly [K in keyof Deps as Deps[K] extends AnyInjectable
    ? K
    : never]: Deps[K] extends AnyInjectable
    ? ResolveInjectableType<Deps[K]>
    : never
} & {
  readonly [K in keyof Deps as Deps[K] extends DependencyOptional
    ? K
    : never]?: Deps[K] extends DependencyOptional
    ? ResolveInjectableType<Deps[K]['injectable']>
    : never
}

export type InjectableFactoryType<
  InjectableType,
  InjectableDeps extends Dependencies,
> = (context: DependencyContext<InjectableDeps>) => MaybePromise<InjectableType>

export type InjectablePickType<Input, Output> = (injectable: Input) => Output

export type InjectableDisposeType<
  InjectableType,
  InjectableDeps extends Dependencies,
> = (
  instance: InjectableType,
  context: DependencyContext<InjectableDeps>,
) => any

export interface LazyInjectable<T, S extends Scope = Scope.Global>
  extends Dependant<{}> {
  scope: S
  $withType<O extends T>(): LazyInjectable<O, S>
  optional(): DependencyOptional<LazyInjectable<T, S>>
  [kInjectable]: any
  [kLazyInjectable]: T
}

export interface ValueInjectable<T> extends Dependant<{}> {
  scope: Scope.Global
  value: T
  [kInjectable]: any
  [kValueInjectable]: any
}

export interface FactoryInjectable<
  T,
  D extends Dependencies = {},
  S extends Scope = Scope.Global,
  P = T,
> extends Dependant<D> {
  scope: S
  factory: InjectableFactoryType<P, D>
  pick: InjectablePickType<P, T>
  dispose?: InjectableDisposeType<P, D>
  optional(): DependencyOptional<FactoryInjectable<T, D, S, P>>
  [kInjectable]: any
  [kFactoryInjectable]: any
}

export type Injectable<
  V = any,
  D extends Dependencies = {},
  S extends Scope = Scope,
> = LazyInjectable<V, S> | ValueInjectable<V> | FactoryInjectable<V, D, S, any>

export type AnyInjectable<T = any, S extends Scope = Scope> = Injectable<
  T,
  any,
  S
>

export const isLazyInjectable = (
  injectable: any,
): injectable is LazyInjectable<any> => injectable[kLazyInjectable]

export const isFactoryInjectable = (
  injectable: any,
): injectable is FactoryInjectable<any> => injectable[kFactoryInjectable]

export const isValueInjectable = (
  injectable: any,
): injectable is ValueInjectable<any> => injectable[kValueInjectable]

export const isInjectable = (
  injectable: any,
): injectable is AnyInjectable<any> => injectable[kInjectable]

export const isOptionalInjectable = (
  injectable: any,
): injectable is DependencyOptional<any> => injectable[kOptionalDependency]

export function getInjectableScope(injectable: AnyInjectable) {
  let scope = injectable.scope
  const deps = injectable.dependencies as Dependencies
  for (const key in deps) {
    const dependency = deps[key]
    const injectable = getDepedencencyInjectable(dependency)
    const dependencyScope = getInjectableScope(injectable)
    if (
      dependencyScope !== Scope.Transient &&
      scope !== Scope.Transient &&
      compareScope(dependencyScope, '>', scope)
    ) {
      scope = dependencyScope
    }
  }
  return scope
}

export function getDepedencencyInjectable(
  dependency: Depedency,
): AnyInjectable {
  if (kOptionalDependency in dependency) {
    return dependency.injectable
  }
  return dependency
}

export function createOptionalInjectable<T extends AnyInjectable>(
  injectable: T,
) {
  return Object.freeze({
    [kOptionalDependency]: true,
    injectable,
  }) as DependencyOptional<T>
}

export function createLazyInjectable<T, S extends Scope = Scope.Global>(
  scope = Scope.Global as S,
  label?: string,
  stackTraceDepth = 0,
): LazyInjectable<T, S> {
  const injectable = Object.freeze({
    scope,
    dependencies: {},
    label,
    stack: tryCaptureStackTrace(stackTraceDepth),
    optional: () => createOptionalInjectable(injectable),
    $withType: () => injectable as any,
    [kInjectable]: true,
    [kLazyInjectable]: true as unknown as T,
  })
  return injectable
}

export function createValueInjectable<T>(
  value: T,
  label?: string,
  stackTraceDepth = 0,
): ValueInjectable<T> {
  return Object.freeze({
    value,
    scope: Scope.Global,
    dependencies: {},
    label,
    stack: tryCaptureStackTrace(stackTraceDepth),
    [kInjectable]: true,
    [kValueInjectable]: true,
  })
}

export function createFactoryInjectable<
  T,
  D extends Dependencies = {},
  S extends Scope = Scope.Global,
  P = T,
>(
  paramsOrFactory:
    | {
        dependencies?: D
        scope?: S
        pick?: InjectablePickType<P, T>
        factory: InjectableFactoryType<P, D>
        dispose?: InjectableDisposeType<P, D>
      }
    | InjectableFactoryType<P, D>,
  label?: string,
  stackTraceDepth = 0,
): FactoryInjectable<null extends T ? P : T, D, S, P> {
  const isFactory = typeof paramsOrFactory === 'function'
  const params = isFactory ? { factory: paramsOrFactory } : paramsOrFactory
  const injectable = {
    dependencies: (params.dependencies ?? {}) as D,
    scope: (params.scope ?? Scope.Global) as S,
    factory: params.factory,
    dispose: params.dispose,
    pick: params.pick ?? ((instance: P) => instance as unknown as T),
    label,
    stack: tryCaptureStackTrace(stackTraceDepth),
    optional: () => createOptionalInjectable(injectable),
    [kInjectable]: true,
    [kFactoryInjectable]: true,
  }
  injectable.scope = resolveInjectableScope(
    typeof params.scope === 'undefined',
    injectable,
  ) as S
  return Object.freeze(injectable) as any
}

export type DependenciesSubstitution<T extends Dependencies> = {
  [K in keyof T]?: T[K] extends AnyInjectable<infer Type>
    ? AnyInjectable<Type> | DependenciesSubstitution<T[K]['dependencies']>
    : never
}

export function substitute<T extends FactoryInjectable<any, any, Scope>>(
  injectable: T,
  substitution: DependenciesSubstitution<T['dependencies']>,
  stackTraceDepth = 0,
): T {
  const dependencies = { ...injectable.dependencies }
  const depth = stackTraceDepth + 1
  for (const key in substitution) {
    const value = substitution[key]!
    if (key in dependencies) {
      const original = dependencies[key]
      if (isInjectable(value)) {
        dependencies[key] = value
      } else if (isFactoryInjectable(original)) {
        dependencies[key] = substitute(original, value, depth)
      }
    }
  }

  if (isFactoryInjectable(injectable)) {
    // @ts-expect-error
    return createFactoryInjectable(
      { ...injectable, dependencies },
      injectable.label,
      depth,
    )
  }

  throw new Error('Invalid injectable type')
}

export function compareScope(
  left: Scope,
  operator: '>' | '<' | '>=' | '<=' | '=' | '!=',
  right: Scope,
) {
  const leftScope = ScopeStrictness[left]
  const rightScope = ScopeStrictness[right]
  switch (operator) {
    case '=':
      return leftScope === rightScope
    case '!=':
      return leftScope !== rightScope
    case '>':
      return leftScope > rightScope
    case '<':
      return leftScope < rightScope
    case '>=':
      return leftScope >= rightScope
    case '<=':
      return leftScope <= rightScope
    default:
      throw new Error('Invalid operator')
  }
}

const loggerInjectable = Object.assign(
  (label: string) =>
    createFactoryInjectable({
      dependencies: { logger: loggerInjectable },
      scope: Scope.Global,
      factory: ({ logger }) => logger.child({ $label: label }),
    }),
  createLazyInjectable<Logger>(Scope.Global, 'Logger'),
) as unknown as ((
  label: string,
) => FactoryInjectable<Logger, { logger: LazyInjectable<Logger> }>) &
  LazyInjectable<Logger>

const injectFnInjectable = createLazyInjectable<InjectFn>(
  Scope.Global,
  'Inject function',
)
const disposeFnInjectable = createLazyInjectable<DisposeFn>(
  Scope.Global,
  'Dispose function',
)

function resolveInjectableScope(
  isDefaultScope: boolean,
  injectable: AnyInjectable,
) {
  const actualScope = getInjectableScope(injectable)
  if (!isDefaultScope && compareScope(actualScope, '>', injectable.scope))
    throw new Error(
      `Invalid scope ${injectable.scope} for an injectable: dependencies have stricter scope - ${actualScope}`,
    )
  return actualScope
}

export namespace CoreInjectables {
  export const logger = loggerInjectable
  export const inject = injectFnInjectable
  export const dispose = disposeFnInjectable
}

export type Injection<
  T extends AnyInjectable<any, any> = AnyInjectable<any, any>,
> = {
  token: T
  value: T extends AnyInjectable<infer R, Scope> ? R | AnyInjectable<R> : never
}

export const provision = <
  T extends AnyInjectable<any, any>,
  V extends T extends AnyInjectable<infer R, Scope>
    ? R | AnyInjectable<R>
    : never,
>(
  token: T,
  value: V,
): Injection<T> => {
  return { token, value }
}
