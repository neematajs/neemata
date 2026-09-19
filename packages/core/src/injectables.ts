import type { MaybePromise, StackTraceAnchor } from '@nmtjs/common'
import { tryCaptureStackTrace } from '@nmtjs/common'

import type { DisposeFn, InjectFn } from './container.ts'
import type { ChildLoggerOptions, Logger } from './logger.ts'
import {
  kFactoryInjectable,
  kInjectable,
  kLazyInjectable,
  kOptionalDependency,
  kValueInjectable,
} from './constants.ts'
import { Scope } from './enums.ts'
import { forkLogger } from './logger.ts'

/** A scope with a position in the ordering — every scope but Transient. */
export type PositionalScope = Exclude<Scope, Scope.Transient>

// Transient is a lifetime, not a position in the scope ordering — it is
// deliberately absent here so it can never silently pass a comparison
const ScopeOrder: Record<PositionalScope, number> = {
  [Scope.Global]: 1,
  [Scope.Connection]: 2,
  [Scope.Call]: 3,
}

const EMPTY_DEPENDENCIES = Object.freeze({})

export type DependencyOptional<T extends AnyInjectable = AnyInjectable> = {
  [kOptionalDependency]: any
  injectable: T
}

export type Dependency = DependencyOptional | AnyInjectable

export type Dependencies = Record<string, Dependency>

export type ResolveInjectableType<T extends AnyInjectable> =
  T extends Injectable<infer Type, any, any> ? Type : never

export interface Dependant<Deps extends Dependencies = Dependencies> {
  dependencies: Deps
  label?: string
  stack?: string
}

export type DependencyInjectable<T extends Dependency> = T extends AnyInjectable
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

export type HandlerFn<
  Deps extends Dependencies,
  Args extends readonly unknown[],
  Return,
> = (context: DependencyContext<Deps>, ...args: Args) => MaybePromise<Return>

export interface Handler<
  Deps extends Dependencies,
  Args extends readonly unknown[],
  Return,
> extends Dependant<Deps> {
  handler: HandlerFn<Deps, Args, Return>
}

export type HandlerInput<
  Deps extends Dependencies,
  Args extends readonly unknown[],
  Return,
> =
  | HandlerFn<{}, Args, Return>
  | {
      dependencies?: Deps
      handler: HandlerFn<Deps, Args, Return>
    }

export function createHandler<
  Args extends readonly unknown[],
  Return,
  Deps extends Dependencies = {},
>(
  paramsOrHandler: HandlerInput<Deps, Args, Return>,
): Handler<Deps, Args, Return> {
  const { dependencies = {} as Deps, handler } =
    typeof paramsOrHandler === 'function'
      ? { handler: paramsOrHandler }
      : paramsOrHandler

  return Object.freeze({ dependencies, handler }) as Handler<Deps, Args, Return>
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

export interface LazyInjectable<
  T,
  S extends Scope = Scope.Global,
> extends Dependant<{}> {
  scope: S
  $withType<O extends T>(): LazyInjectable<O, S>
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
  create: InjectableFactoryType<P, D>
  pick: InjectablePickType<P, T>
  dispose?: InjectableDisposeType<P, D>
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

// these run on arbitrary user values (inline injections), so they must
// answer false for nullish input instead of throwing
export const isLazyInjectable = (
  injectable: any,
): injectable is LazyInjectable<any> => Boolean(injectable?.[kLazyInjectable])

export const isFactoryInjectable = (
  injectable: any,
): injectable is FactoryInjectable<any> =>
  Boolean(injectable?.[kFactoryInjectable])

export const isValueInjectable = (
  injectable: any,
): injectable is ValueInjectable<any> => Boolean(injectable?.[kValueInjectable])

export const isInjectable = (
  injectable: any,
): injectable is AnyInjectable<any> => Boolean(injectable?.[kInjectable])

export const isOptionalInjectable = (
  injectable: any,
): injectable is DependencyOptional<any> =>
  Boolean(injectable?.[kOptionalDependency])

// dependency records are frozen at creation, so the effective scope of an
// injectable can never change — safe to memoize for the process lifetime
const effectiveScopeCache = new WeakMap<AnyInjectable, PositionalScope>()

/**
 * The positional scope an injectable actually requires: the strictest scope
 * among its own (for non-transients) and all transitive dependencies.
 * Transients contribute no position themselves, but their dependencies do —
 * a transient over Call-scoped dependencies still requires a Call container.
 */
export function getEffectiveInjectableScope(
  injectable: AnyInjectable,
): PositionalScope {
  const cached = effectiveScopeCache.get(injectable)
  if (cached) return cached
  const own =
    injectable.scope === Scope.Transient
      ? Scope.Global
      : (injectable.scope as PositionalScope)
  const scope = strictestScope(own, injectable.dependencies)
  effectiveScopeCache.set(injectable, scope)
  return scope
}

const strictestScope = (own: PositionalScope, dependencies: Dependencies) => {
  let scope = own
  for (const key in dependencies) {
    const dependencyScope = getEffectiveInjectableScope(
      getDependencyInjectable(dependencies[key]),
    )
    if (scopeRank(dependencyScope) > scopeRank(scope)) {
      scope = dependencyScope
    }
  }
  return scope
}

export function getDependencyInjectable(dependency: Dependency): AnyInjectable {
  if (kOptionalDependency in dependency) {
    return dependency.injectable
  }
  return dependency
}

export function optional<T, S extends Scope>(
  injectable: LazyInjectable<T, S>,
): DependencyOptional<LazyInjectable<T, S>> {
  if (!isLazyInjectable(injectable)) {
    throw new TypeError('Optional dependencies can only wrap lazy injectables')
  }
  return Object.freeze({
    [kOptionalDependency]: true,
    injectable,
  }) as DependencyOptional<LazyInjectable<T, S>>
}

/**
 * Where an injectable was declared. A string is a precomputed location
 * (e.g. injected at build time); a function is a capture anchor — the
 * location of whoever called it is captured at creation.
 */
export type InjectableOrigin = string | StackTraceAnchor

const resolveOrigin = (
  origin: InjectableOrigin | undefined,
  anchor: StackTraceAnchor,
) =>
  typeof origin === 'string' ? origin : tryCaptureStackTrace(origin ?? anchor)

export function createLazyInjectable<T, S extends Scope = Scope.Global>(
  scope = Scope.Global as S,
  label?: string,
  origin?: InjectableOrigin,
): LazyInjectable<T, S> {
  const injectable = Object.freeze({
    scope,
    dependencies: EMPTY_DEPENDENCIES,
    label,
    stack: resolveOrigin(origin, createLazyInjectable),
    $withType: () => injectable as any,
    [kInjectable]: true,
    [kLazyInjectable]: true as unknown as T,
  })
  return injectable
}

export function createValueInjectable<T>(
  value: T,
  label?: string,
  origin?: InjectableOrigin,
): ValueInjectable<T> {
  return Object.freeze({
    value,
    scope: Scope.Global,
    dependencies: EMPTY_DEPENDENCIES,
    label,
    stack: resolveOrigin(origin, createValueInjectable),
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
        create: InjectableFactoryType<P, D>
        dispose?: InjectableDisposeType<P, D>
      }
    | InjectableFactoryType<P, D>,
  label?: string,
  origin?: InjectableOrigin,
): FactoryInjectable<null extends T ? P : T, D, S, P> {
  const params =
    typeof paramsOrFactory === 'function'
      ? { create: paramsOrFactory }
      : paramsOrFactory
  // freezing keeps the dependency graph acyclic by construction and makes
  // the effective scope safe to memoize
  const dependencies = Object.freeze({ ...params.dependencies }) as D
  const scope = resolveScope(params.scope, dependencies)
  const pick = params.pick ?? ((instance: P) => instance as unknown as T)

  return Object.freeze({
    dependencies,
    scope: scope as S,
    create: params.create,
    dispose: params.dispose,
    pick,
    label,
    stack: resolveOrigin(origin, createFactoryInjectable),
    [kInjectable]: true,
    [kFactoryInjectable]: true,
  }) as any
}

/**
 * A factory lives in the strictest scope its dependencies require. A scope
 * declared explicitly must be able to host them.
 */
function resolveScope(declared: Scope | undefined, dependencies: Dependencies) {
  if (declared === Scope.Transient) return Scope.Transient
  const scope = strictestScope(
    (declared as PositionalScope) ?? Scope.Global,
    dependencies,
  )
  if (declared !== undefined && scopeRank(scope) > scopeRank(declared)) {
    throw new Error(
      `Invalid scope ${declared} for an injectable: dependencies have stricter scope - ${scope}`,
    )
  }
  return scope
}

export type DependenciesSubstitution<T extends Dependencies> = {
  [K in keyof T]?: T[K] extends AnyInjectable<infer Type>
    ? AnyInjectable<Type> | DependenciesSubstitution<T[K]['dependencies']>
    : never
}

export function substitute<T extends FactoryInjectable<any, any, Scope>>(
  injectable: T,
  substitution: DependenciesSubstitution<T['dependencies']>,
  origin?: InjectableOrigin,
): T {
  if (!isFactoryInjectable(injectable)) {
    throw new Error('Invalid injectable type')
  }

  // capture once at the API boundary and pass the value down, so nested
  // substitutions all attribute to the original call site
  const stack = resolveOrigin(origin, substitute)
  const dependencies = { ...injectable.dependencies }
  for (const [key, value] of Object.entries(substitution)) {
    if (!(key in dependencies)) continue
    const original = dependencies[key]
    if (isInjectable(value)) {
      dependencies[key] = value
    } else if (isFactoryInjectable(original)) {
      dependencies[key] = substitute(original, value, stack)
    }
  }

  // the substituted dependencies no longer match T's declared ones, which is
  // the point of a substitution
  return createFactoryInjectable(
    { ...injectable, dependencies },
    injectable.label,
    stack,
  ) as unknown as T
}

/** Position of a scope in the ordering; Transient has none. */
export function scopeRank(scope: Scope): number {
  const rank = ScopeOrder[scope as PositionalScope]
  if (rank === undefined) {
    throw new Error(
      'Transient scope is a lifetime, not a position — it cannot be compared',
    )
  }
  return rank
}

const loggerInjectable = Object.assign(
  (label: string | undefined, options?: ChildLoggerOptions) => {
    return createFactoryInjectable({
      dependencies: { logger: loggerInjectable },
      scope: Scope.Global,
      create: ({ logger }) => forkLogger(logger, label, options),
    })
  },
  createLazyInjectable<Logger>(Scope.Global, 'Logger'),
  // the options parameter stays off the declared signature: naming pino's
  // ChildLoggerOptions here makes every consumer's declaration emit depend on
  // pino's own types
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

export const CoreInjectables = {
  logger: loggerInjectable,
  inject: injectFnInjectable,
  dispose: disposeFnInjectable,
}

export type ProvisionValue<T extends AnyInjectable<any, any>> =
  T extends AnyInjectable<infer R, Scope> ? R | AnyInjectable<R> : never

export type Provision<
  T extends AnyInjectable<any, any> = AnyInjectable<any, any>,
> = { token: T; value: ProvisionValue<T> }

export const provision = <
  T extends AnyInjectable<any, any>,
  V extends ProvisionValue<T>,
>(
  token: T,
  value: V,
): Provision<T> => {
  return { token, value }
}
