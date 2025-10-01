import type {
  Async,
  Callback,
  ClassConstructor,
  ClassConstructorArgs,
  ClassInstance,
} from '@nmtjs/common'
import { tryCaptureStackTrace } from '@nmtjs/common'

import type { DisposeFn, InjectFn } from './container.ts'
import type { Hook } from './enums.ts'
import type { HookType } from './hooks.ts'
import type { Logger } from './logger.ts'
import type { Registry } from './registry.ts'
import {
  kClassInjectable,
  kClassInjectableCreate,
  kClassInjectableDispose,
  kFactoryInjectable,
  kHookCollection,
  kInjectable,
  kLazyInjectable,
  kOptionalDependency,
  kValueInjectable,
} from './constants.ts'
import { Scope } from './enums.ts'
import { Hooks } from './hooks.ts'

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
> = (context: DependencyContext<InjectableDeps>) => Async<InjectableType>

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
  [kInjectable]: any
  [kFactoryInjectable]: any
}

export interface BaseClassInjectable<
  T,
  D extends Dependencies = {},
  S extends Scope = Scope.Global,
> extends Dependant<D> {
  new (...args: any[]): T
  scope: S
  [kInjectable]: any
  [kClassInjectable]: any
}

export interface ClassInjectable<
  T,
  D extends Dependencies = {},
  S extends Scope = Scope.Global,
  A extends any[] = [],
> extends Dependant<D> {
  new (
    $context: DependencyContext<D>,
    ...args: A
  ): T & { $context: DependencyContext<D> }
  scope: S
  [kInjectable]: any
  [kClassInjectable]: any
}

export type Injectable<
  V = any,
  D extends Dependencies = {},
  S extends Scope = Scope,
> =
  | LazyInjectable<V, S>
  | ValueInjectable<V>
  | FactoryInjectable<V, D, S, any>
  | BaseClassInjectable<V, D, S>

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

export const isClassInjectable = (
  injectable: any,
): injectable is ClassInjectable<any> => injectable[kClassInjectable]

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
  return Object.freeze({
    scope,
    dependencies: {},
    label,
    stack: tryCaptureStackTrace(stackTraceDepth),
    [kInjectable]: true,
    [kLazyInjectable]: true as unknown as T,
  })
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
    [kInjectable]: true,
    [kFactoryInjectable]: true,
  }
  injectable.scope = resolveInjectableScope(
    typeof params.scope === 'undefined',
    injectable,
  ) as S
  return Object.freeze(injectable) as any
}

export const createClassInjectable = <
  D extends Dependencies = {},
  S extends Scope = Scope.Global,
>(
  dependencies: D = {} as D,
  scope?: S,
  stackTraceDepth = 0,
): ClassInjectable<ClassInstance<typeof InjectableClass>, D, S> => {
  const InjectableClass = class {
    static dependencies = dependencies
    static scope = (scope ?? Scope.Global) as S
    static stack = tryCaptureStackTrace(stackTraceDepth + 2)
    static [kInjectable] = true
    static [kClassInjectable] = true

    static get label() {
      // biome-ignore lint/complexity/noThisInStatic: ok
      return this.name
    }

    constructor(public $context: DependencyContext<D>) {}

    async [kClassInjectableCreate]() {}
    async [kClassInjectableDispose]() {}
  }

  InjectableClass.scope = resolveInjectableScope(
    typeof scope === 'undefined',
    InjectableClass,
  ) as S

  return InjectableClass
}

export function createExtendableClassInjectable<
  B extends ClassConstructor<any>,
  D extends Dependencies = {},
  S extends Scope = Scope.Global,
>(
  baseClass: B,
  dependencies: D = {} as D,
  scope?: S,
  stackTraceDepth = 0,
): B extends ClassInjectable<any>
  ? ClassInjectable<ClassInstance<B>, D, S>
  : ClassInjectable<ClassInstance<B>, D, S, ClassConstructorArgs<B, []>> {
  if (isClassInjectable(baseClass)) {
    if (scope && compareScope(baseClass.scope, '>', scope)) {
      throw new Error(
        `Invalid scope ${scope} for an extendable class injectable: base class have stricter scope - ${baseClass.scope}`,
      )
    } else {
      scope = scope ?? (baseClass.scope as S)
    }
    dependencies = Object.assign({}, baseClass.dependencies, dependencies)
  }

  const InjectableClass = class extends baseClass {
    static dependencies = dependencies
    static scope = (scope ?? Scope.Global) as S
    static stack = tryCaptureStackTrace(stackTraceDepth)
    static [kInjectable] = true
    static [kClassInjectable] = true

    static get label() {
      // biome-ignore lint/complexity/noThisInStatic: ok
      return this.name
    }

    $context!: DependencyContext<D>

    constructor(...args: any[]) {
      const [$context, ...baseClassArgs] = args
      if (isClassInjectable(baseClass)) {
        super($context)
      } else {
        super(...baseClassArgs)
      }
      this.$context = $context
    }

    protected async $onCreate() {
      await super.$onCreate?.()
    }

    protected async $onDispose() {
      await super.$onDispose?.()
    }
  }

  InjectableClass.scope = resolveInjectableScope(
    typeof scope === 'undefined',
    InjectableClass,
  ) as S

  // @ts-expect-error
  return InjectableClass
}

export type DependenciesSubstitution<T extends Dependencies> = {
  [K in keyof T]?: T[K] extends AnyInjectable<infer Type>
    ? AnyInjectable<Type> | DependenciesSubstitution<T[K]['dependencies']>
    : never
}

export function substitute<
  T extends
    | FactoryInjectable<any, any, Scope>
    | BaseClassInjectable<any, any, Scope>,
>(
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
      } else if (isClassInjectable(original) || isFactoryInjectable(original)) {
        dependencies[key] = substitute(original, value, depth)
      }
    }
  }

  if (isClassInjectable(injectable)) {
    // @ts-expect-error
    return createExtendableClassInjectable(
      injectable,
      dependencies,
      injectable.scope,
      depth,
    )
  } else if (isFactoryInjectable(injectable)) {
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

const logger = createLazyInjectable<Logger>(Scope.Global, 'Logger')
const registry = createLazyInjectable<Registry>(Scope.Global, 'Registry')
const inject = createLazyInjectable<InjectFn>(Scope.Global, 'Inject function')
const dispose = createLazyInjectable<DisposeFn>(
  Scope.Global,
  'Dispose function',
)
const hook = createFactoryInjectable({
  scope: Scope.Transient,
  dependencies: { registry },
  factory: ({ registry }) => {
    const hooks = new Hooks()
    const on = <T extends Hook>(name: T, callback: HookType[T]) => {
      hooks.add(name, callback as Callback)
      return registry.hooks.add(name, callback)
    }
    return { hooks, on }
  },
  pick: ({ on }) => on,
  dispose: ({ hooks }, { registry }) => {
    for (const [hook, callbacks] of hooks[kHookCollection].entries()) {
      for (const callback of callbacks) {
        registry.hooks.remove(hook, callback)
      }
    }
    hooks.clear()
  },
})

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

export const CoreInjectables = { logger, registry, inject, dispose, hook }
