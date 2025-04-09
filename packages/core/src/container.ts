import { type Async, tryCaptureStackTrace } from '@nmtjs/common'
import {
  kFactoryInjectable,
  kInjectable,
  kLazyInjectable,
  kOptionalDependency,
  kValueInjectable,
} from './constants.ts'
import { Scope } from './enums.ts'
import type { Logger } from './logger.ts'
import type { Registry } from './registry.ts'

const ScopeStrictness = {
  [Scope.Global]: 0,
  [Scope.Connection]: 1,
  [Scope.Call]: 2,
  [Scope.Transient]: 3,
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

export type Injectable<
  InjectableValue = any,
  InjectableDeps extends Dependencies = {},
  InjectableScope extends Scope = Scope,
> =
  | LazyInjectable<InjectableValue, InjectableScope>
  | ValueInjectable<InjectableValue>
  | FactoryInjectable<InjectableValue, InjectableDeps, InjectableScope, any>

export type AnyInjectable<T = any, S extends Scope = Scope> = Injectable<
  T,
  any,
  S
>

export class Container {
  readonly instances = new Map<
    AnyInjectable,
    { instance: any; picked: any; context: any }
  >()
  private readonly resolvers = new Map<AnyInjectable, Promise<any>>()
  private readonly injectables = new Set<AnyInjectable>()
  private readonly dependants = new Map<AnyInjectable, Set<AnyInjectable>>()

  constructor(
    private readonly application: {
      registry: Registry
      logger: Logger
    },
    public readonly scope: Exclude<Scope, Scope.Transient> = Scope.Global,
    private readonly parent?: Container,
  ) {
    if ((scope as any) === Scope.Transient) {
      throw new Error('Invalid scope')
    }
  }

  async load() {
    const traverse = (dependencies: Dependencies) => {
      for (const key in dependencies) {
        const dependency = dependencies[key]
        const injectable = getDepedencencyInjectable(dependency)
        this.injectables.add(injectable)
        traverse(injectable.dependencies)
      }
    }

    for (const dependant of this.application.registry.getDependants()) {
      traverse(dependant.dependencies)
    }

    const injectables = Array.from(this.findCurrentScopeInjectables())
    await Promise.all(injectables.map((injectable) => this.resolve(injectable)))
  }

  fork(scope: Exclude<Scope, Scope.Transient>) {
    return new Container(this.application, scope, this)
  }

  async dispose() {
    this.application.logger.trace('Disposing [%s] scope context...', this.scope)

    // Loop through all instances and dispose them,
    // until there are no more instances left
    while (this.instances.size) {
      for (const injectable of this.instances.keys()) {
        const dependants = this.dependants.get(injectable)
        // Firstly, dispose instances that other injectables don't depend on
        if (!dependants?.size) {
          await this.disposeInjectable(injectable)
          for (const dependants of this.dependants.values()) {
            // Clear current istances as a dependant for other injectables
            if (dependants.has(injectable)) {
              dependants.delete(injectable)
            }
          }
        }
      }
    }

    this.instances.clear()
    this.injectables.clear()
    this.resolvers.clear()
    this.dependants.clear()
  }

  containsWithinSelf(injectable: AnyInjectable) {
    return this.instances.has(injectable) || this.resolvers.has(injectable)
  }

  contains(injectable: AnyInjectable): boolean {
    return (
      this.containsWithinSelf(injectable) ||
      (this.parent?.contains(injectable) ?? false)
    )
  }

  get<T extends AnyInjectable>(injectable: T): ResolveInjectableType<T> {
    if (this.instances.has(injectable)) {
      return this.instances.get(injectable)!.instance
    }

    if (this.parent?.contains(injectable)) {
      return this.parent.get(injectable)
    }

    throw new Error('No instance found')
  }

  resolve<T extends AnyInjectable>(injectable: T) {
    return this.resolveInjectable(injectable)
  }

  async createContext<T extends Dependencies>(dependencies: T) {
    return this.createInjectableContext(dependencies)
  }

  private async createInjectableContext<T extends Dependencies>(
    dependencies: T,
    dependant?: AnyInjectable,
  ) {
    const injections: Record<string, any> = {}
    const deps = Object.entries(dependencies)
    const resolvers: Promise<any>[] = Array(deps.length)
    for (let i = 0; i < deps.length; i++) {
      const [key, dependency] = deps[i]
      const injectable = getDepedencencyInjectable(dependency)
      const resolver = this.resolveInjectable(injectable, dependant)
      resolvers[i] = resolver.then((value) => (injections[key] = value))
    }
    await Promise.all(resolvers)
    return Object.freeze(injections) as DependencyContext<T>
  }

  async provide<T extends AnyInjectable>(
    injectable: T,
    instance: ResolveInjectableType<T>,
  ) {
    if (compareScope(injectable.scope, '>', this.scope)) {
      throw new Error('Invalid scope') // TODO: more informative error
    }
    this.instances.set(injectable, {
      instance,
      picked: instance,
      context: undefined,
    })
  }

  satisfies(injectable: AnyInjectable) {
    return compareScope(injectable.scope, '<=', this.scope)
  }

  private *findCurrentScopeInjectables() {
    for (const injectable of this.injectables) {
      if (injectable.scope === this.scope) {
        yield injectable
      }
    }
  }

  private resolveInjectable<T extends AnyInjectable>(
    injectable: T,
    dependant?: AnyInjectable,
  ): Promise<ResolveInjectableType<T>> {
    if (dependant && compareScope(dependant.scope, '<', injectable.scope)) {
      // TODO: more informative error
      throw new Error('Invalid scope: dependant is looser than injectable')
    }

    if (checkIsValueInjectable(injectable)) {
      return Promise.resolve(injectable.value)
    } else if (
      this.parent?.contains(injectable) ||
      (this.parent?.satisfies(injectable) &&
        compareScope(this.parent.scope, '<', this.scope))
    ) {
      return this.parent.resolveInjectable(injectable, dependant)
    } else {
      const { scope, dependencies, stack, label } = injectable

      if (dependant && compareScope(scope, '=', dependant.scope)) {
        let dependants = this.dependants.get(injectable)
        if (!dependants) {
          this.dependants.set(injectable, (dependants = new Set()))
        }
        dependants.add(dependant)
      }

      if (this.instances.has(injectable)) {
        return Promise.resolve(this.instances.get(injectable)!.picked)
      } else if (this.resolvers.has(injectable)) {
        return this.resolvers.get(injectable)!
      } else {
        const isLazy = checkIsLazyInjectable(injectable)

        if (isLazy) {
          const isOptional = checkIsOptional(injectable)
          if (isOptional) return Promise.resolve(undefined as any)
          return Promise.reject(
            new Error(
              `No instance provided for ${label || 'an'} injectable:\n${stack}`,
            ),
          )
        } else if (!checkIsFactoryInjectable(injectable)) {
          throw new Error('Invalid injectable')
        }

        const resolution = this.createInjectableContext(
          dependencies,
          injectable,
        )
          .then((context) =>
            Promise.resolve(injectable.factory(context)).then((instance) => ({
              instance,
              context,
            })),
          )
          .then(({ instance, context }) => {
            const picked = injectable.pick(instance)
            if (compareScope(this.scope, '>=', scope))
              this.instances.set(injectable, { instance, picked, context })
            if (scope !== Scope.Transient) this.resolvers.delete(injectable)
            return picked
          })
        if (scope !== Scope.Transient)
          this.resolvers.set(injectable, resolution)
        return resolution
      }
    }
  }

  private async disposeInjectable(injectable: AnyInjectable) {
    try {
      if (kFactoryInjectable in injectable) {
        const { dispose } = injectable
        if (dispose) {
          const { instance, context } = this.instances.get(injectable)!
          await dispose(instance, context)
        }
      }
    } catch (cause) {
      const error = new Error(
        'Injectable disposal error. Potential memory leak',
        { cause },
      )
      this.application.logger.error(error)
    } finally {
      this.instances.delete(injectable)
    }
  }
}

function compareScope(
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

export const checkIsLazyInjectable = (
  injectable: any,
): injectable is LazyInjectable<any> => kLazyInjectable in injectable
export const checkIsFactoryInjectable = (
  injectable: any,
): injectable is FactoryInjectable<any> => kFactoryInjectable in injectable
export const checkIsValueInjectable = (
  injectable: any,
): injectable is ValueInjectable<any> => kValueInjectable in injectable
export const checkIsInjectable = (
  injectable: any,
): injectable is AnyInjectable<any> => kInjectable in injectable
export const checkIsOptional = (
  injectable: any,
): injectable is DependencyOptional<any> => kOptionalDependency in injectable

export function getInjectableScope(injectable: AnyInjectable) {
  let scope = injectable.scope
  const deps = Object.values(injectable.dependencies as Dependencies)
  for (const dependency of deps) {
    const injectable = getDepedencencyInjectable(dependency)
    const dependencyScope = getInjectableScope(injectable)
    if (compareScope(dependencyScope, '>', scope)) {
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
  return {
    [kOptionalDependency]: true,
    injectable,
  } as DependencyOptional<T>
}

export function createLazyInjectable<T, S extends Scope = Scope.Global>(
  scope = Scope.Global as S,
  label?: string,
): LazyInjectable<T, S> {
  return Object.freeze({
    scope,
    dependencies: {},
    label,
    stack: tryCaptureStackTrace(),
    [kInjectable]: true,
    [kLazyInjectable]: true as unknown as T,
  })
}

export function createValueInjectable<T>(
  value: T,
  label?: string,
): ValueInjectable<T> {
  return Object.freeze({
    value,
    scope: Scope.Global,
    dependencies: {},
    label,
    stack: tryCaptureStackTrace(),
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
    stack: tryCaptureStackTrace(),
    [kInjectable]: true,
    [kFactoryInjectable]: true,
  }
  const actualScope = getInjectableScope(injectable)
  if (
    !isFactory &&
    params.scope &&
    ScopeStrictness[actualScope] > ScopeStrictness[params.scope]
  )
    throw new Error(
      `Invalid scope ${params.scope} for factory injectable: dependencies have stricter scope - ${actualScope}`,
    )
  injectable.scope = actualScope as unknown as S
  return Object.freeze(injectable) as any
}
