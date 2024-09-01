import {
  FactoryInjectableKey,
  InjectableKey,
  LazyInjectableKey,
  OptionalDependencyKey,
  Scope,
  ValueInjectableKey,
} from './constants.ts'
import type { Logger } from './logger.ts'
import type { Registry } from './registry.ts'
import type { Async } from './types.ts'

const ScopeStrictness = {
  [Scope.Global]: 0,
  [Scope.Connection]: 1,
  [Scope.Call]: 2,
  [Scope.Transient]: 3,
}

export type DependencyOptional = {
  [OptionalDependencyKey]: any
  injectable: AnyInjectable
}

export type Depedency = DependencyOptional | AnyInjectable

export type Dependencies = Record<string, Depedency>

export type ResolveInjectableType<T extends AnyInjectable> =
  T extends Injectable<infer Type, any, any> ? Type : never

export interface Dependant<Deps extends Dependencies = Dependencies> {
  dependencies: Deps
}

export type DependencyInjectable<T extends Depedency> = T extends AnyInjectable
  ? T
  : T extends DependencyOptional
    ? T['injectable']
    : never

export type DependencyContext<Deps extends Dependencies> = {
  [K in keyof Deps as Deps[K] extends AnyInjectable
    ? K
    : never]: Deps[K] extends AnyInjectable
    ? ResolveInjectableType<Deps[K]>
    : never
} & {
  [K in keyof Deps as Deps[K] extends DependencyOptional
    ? K
    : never]?: Deps[K] extends DependencyOptional
    ? ResolveInjectableType<Deps[K]['injectable']>
    : never
}

export type InjectableFactoryType<
  InjectableType,
  InjectableDeps extends Dependencies,
> = (context: DependencyContext<InjectableDeps>) => Async<InjectableType>

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
  [InjectableKey]: any
  [LazyInjectableKey]: T
}

export interface ValueInjectable<T> extends Dependant<{}> {
  scope: Scope.Global
  value: T
  [InjectableKey]: any
  [ValueInjectableKey]: any
}

export interface FactoryInjectable<
  T,
  D extends Dependencies = {},
  S extends Scope = Scope.Global,
> extends Dependant<D> {
  scope: S
  factory(context: DependencyContext<D>): Async<T>
  dispose?(instance: T, context: DependencyContext<D>): any
  [InjectableKey]: any
  [FactoryInjectableKey]: any
}

export type Injectable<
  InjectableValue = any,
  InjectableDeps extends Dependencies = {},
  InjectableScope extends Scope = Scope,
> =
  | LazyInjectable<InjectableValue, InjectableScope>
  | ValueInjectable<InjectableValue>
  | FactoryInjectable<InjectableValue, InjectableDeps, InjectableScope>

export type AnyInjectable<T = any, S extends Scope = Scope> = Injectable<
  T,
  any,
  S
>

export class Container {
  readonly instances = new Map<AnyInjectable, { instance: any; context: any }>()
  private readonly resolvers = new Map<AnyInjectable, Promise<any>>()
  private readonly injectables = new Set<AnyInjectable>()
  private readonly dependants = new Map<AnyInjectable, Set<AnyInjectable>>()

  constructor(
    private readonly application: {
      registry: Registry
      logger: Logger
    },
    public readonly scope: Scope = Scope.Global,
    private readonly parent?: Container,
  ) {}

  async load() {
    const traverse = (dependencies: Dependencies) => {
      for (const key in dependencies) {
        const dependency = dependencies[key]
        const injectable = getDepedencencyInjectable(dependency)
        this.injectables.add(injectable)
        traverse(injectable.dependencies)
      }
    }

    for (const dependant of this.getGlobals()) {
      traverse(dependant.dependencies)
    }

    const injectables = this.findCurrentScopeDeclarations()
    await Promise.all(injectables.map((injectable) => this.resolve(injectable)))
  }

  createScope(scope: Scope) {
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

  has(injectable: AnyInjectable): boolean {
    return !!(
      this.instances.has(injectable) ||
      this.resolvers.has(injectable) ||
      this.parent?.has(injectable)
    )
  }

  resolve<T extends AnyInjectable>(
    injectable: T,
    dependant?: AnyInjectable,
  ): Promise<ResolveInjectableType<T>> {
    if (dependant) {
      let dependants = this.dependants.get(injectable)
      if (!dependants) {
        this.dependants.set(injectable, (dependants = new Set()))
      }
      dependants.add(dependant)
    }

    if (this.instances.has(injectable)) {
      return Promise.resolve(this.instances.get(injectable)!.instance)
    } else if (this.resolvers.has(injectable)) {
      return this.resolvers.get(injectable)!
    } else {
      const { scope, dependencies } = injectable
      if (ValueInjectableKey in injectable)
        return Promise.resolve(injectable.value)

      if (this.parent?.has(injectable)) return this.parent.resolve(injectable)

      const isOptional = checkOptional(injectable)

      const isLazy = LazyInjectableKey in injectable

      if (isLazy) {
        if (isOptional) return Promise.resolve(undefined as any)
        // TODO: this is not very informative
        return Promise.reject(new Error('Missing dependency'))
      }

      const resolution = this.createContext(dependencies, injectable)
        .then((context) =>
          Promise.resolve(injectable.factory(context)).then((instance) => ({
            instance,
            context,
          })),
        )
        .then(({ instance, context }) => {
          if (ScopeStrictness[this.scope] >= ScopeStrictness[scope])
            this.instances.set(injectable, { instance, context })
          if (scope !== Scope.Transient) this.resolvers.delete(injectable)
          return instance
        })
      if (scope !== Scope.Transient) this.resolvers.set(injectable, resolution)
      return resolution
    }
  }

  async createContext<T extends Dependencies>(
    dependencies: T,
    dependant?: AnyInjectable,
  ) {
    const injections: Record<string, any> = {}
    const deps = Object.entries(dependencies)
    const resolvers: Promise<any>[] = Array(deps.length)
    for (let i = 0; i < deps.length; i++) {
      const [key, dependency] = deps[i]
      const injectable = getDepedencencyInjectable(dependency)
      const resolver = this.resolve(injectable, dependant)
      resolvers[i] = resolver.then((value) => (injections[key] = value))
    }
    await Promise.all(resolvers)
    return Object.freeze(injections as DependencyContext<T>)
  }

  async provide<T extends AnyInjectable>(
    injectable: T,
    instance: ResolveInjectableType<T>,
  ) {
    this.instances.set(injectable, { instance, context: undefined })
  }

  private findCurrentScopeDeclarations() {
    const declarations: AnyInjectable[] = []
    for (const injectable of this.injectables) {
      if (injectable.scope === this.scope) {
        declarations.push(injectable)
      }
    }
    return declarations
  }

  private *getGlobals() {
    for (const filter of this.application.registry.filters.values()) {
      yield filter
    }
    for (const task of this.application.registry.tasks.values()) {
      yield task
    }
    for (const service of this.application.registry.services.values()) {
      for (const guard of service.guards.values()) {
        yield guard
      }
      for (const middleware of service.middlewares.values()) {
        yield middleware
      }
      for (const procedure of service.procedures.values()) {
        yield procedure

        for (const guard of procedure.guards.values()) {
          yield guard
        }

        for (const middleware of procedure.middlewares.values()) {
          yield middleware
        }
      }
    }
  }

  private async disposeInjectable(injectable: AnyInjectable) {
    try {
      if (FactoryInjectableKey in injectable) {
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

export function getInjectableScope(injectable: AnyInjectable) {
  let scope = injectable.scope
  const deps = Object.values(injectable.dependencies as Dependencies)
  for (const dependency of deps) {
    const injectable = getDepedencencyInjectable(dependency)
    const dependencyScope = getInjectableScope(injectable)
    if (ScopeStrictness[dependencyScope] > ScopeStrictness[scope]) {
      scope = dependencyScope
    }
  }
  return scope
}

export function getDepedencencyInjectable(
  dependency: Depedency,
): AnyInjectable {
  if (OptionalDependencyKey in dependency) {
    return dependency.injectable
  }
  return dependency
}

function checkOptional(injectable: Depedency) {
  return OptionalDependencyKey in injectable
}

export function asOptional<T extends AnyInjectable>(injectable: T) {
  return {
    [OptionalDependencyKey]: true,
    injectable,
  } as const satisfies DependencyOptional
}

export function createLazyInjectable<T, S extends Scope = Scope.Global>(
  scope = Scope.Global as S,
): LazyInjectable<T, S> {
  return {
    scope,
    dependencies: {},
    [InjectableKey]: true,
    [LazyInjectableKey]: true as unknown as T,
  } as const
}

export function createValueInjectable<T>(value: T): ValueInjectable<T> {
  return {
    value,
    scope: Scope.Global,
    dependencies: {},
    [InjectableKey]: true,
    [ValueInjectableKey]: true,
  } as const
}

export function createFactoryInjectable<
  T,
  D extends Dependencies = {},
  S extends Scope = Scope.Global,
>(
  paramsOrFactory:
    | {
        dependencies?: D
        scope?: S
        factory: InjectableFactoryType<T, D>
        dispose?: InjectableDisposeType<T, D>
      }
    | InjectableFactoryType<T, D>,
): FactoryInjectable<T, D, S> {
  const isFactory = typeof paramsOrFactory === 'function'
  const injectable = {
    dependencies: (isFactory ? {} : paramsOrFactory.dependencies ?? {}) as D,
    scope: (isFactory
      ? Scope.Global
      : paramsOrFactory.scope ?? Scope.Global) as S,
    factory: isFactory ? paramsOrFactory : paramsOrFactory.factory,
    dispose: isFactory ? undefined : paramsOrFactory.dispose,
    [InjectableKey]: true,
    [FactoryInjectableKey]: true,
  }
  const actualScope = getInjectableScope(injectable)
  if (
    !isFactory &&
    paramsOrFactory.scope &&
    ScopeStrictness[actualScope] > ScopeStrictness[paramsOrFactory.scope]
  )
    throw new Error('Invalid scope')
  injectable.scope = actualScope as unknown as S
  return injectable
}

export const options = createValueInjectable('asd' as const)
