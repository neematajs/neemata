import { OptionalDependency, Scope } from './constants.ts'
import type { Logger } from './logger.ts'
import type { Registry } from './registry.ts'
import { merge } from './utils/functions.ts'

const ScopeStrictness = {
  [Scope.Global]: 0,
  [Scope.Connection]: 1,
  [Scope.Call]: 2,
  [Scope.Transient]: 3,
}

export type DependencyOptional = {
  [OptionalDependency]: true
  provider: AnyProvider
}
export type Depedency = DependencyOptional | AnyProvider

export type Dependencies = Record<string, Depedency>

export type ResolveProviderType<T extends AnyProvider> = T extends ProviderLike<
  infer Type,
  any,
  any
>
  ? Type
  : never

export interface Depender<Deps extends Dependencies = Dependencies> {
  dependencies: Deps
}

export type DependencyContext<Deps extends Dependencies> = {
  [K in keyof Deps as Deps[K] extends AnyProvider
    ? K
    : never]: Deps[K] extends AnyProvider ? ResolveProviderType<Deps[K]> : never
} & {
  [K in keyof Deps as Deps[K] extends DependencyOptional
    ? K
    : never]?: Deps[K] extends DependencyOptional
    ? ResolveProviderType<Deps[K]['provider']>
    : never
}

export type ProviderFactoryType<
  ProviderType,
  ProviderDeps extends Dependencies,
> = (context: DependencyContext<ProviderDeps>) => ProviderType

export type ProviderDisposeType<
  ProviderType,
  ProviderDeps extends Dependencies,
> = (
  instance: Awaited<ProviderType>,
  context: DependencyContext<ProviderDeps>,
) => any

export interface ProviderLike<
  ProviderValue = any,
  ProviderDeps extends Dependencies = {},
  ProviderScope extends Scope = Scope,
> extends Depender<ProviderDeps> {
  value: ProviderValue
  dependencies: ProviderDeps
  scope: ProviderScope
  factory: ProviderFactoryType<ProviderValue, ProviderDeps>
  dispose?: ProviderDisposeType<ProviderValue, ProviderDeps>
}

export type AnyProvider<T = any, S extends Scope = Scope> = ProviderLike<
  T,
  any,
  S
>
export class Provider<
  ProviderType = unknown,
  ProviderDeps extends Dependencies = {},
  ProviderScope extends Scope = Scope.Global,
> implements ProviderLike<ProviderType, ProviderDeps, ProviderScope>
{
  value: ProviderType = void 0 as unknown as ProviderType
  dependencies: ProviderDeps = {} as ProviderDeps
  scope: ProviderScope = Scope.Global as ProviderScope
  factory: ProviderFactoryType<ProviderType, ProviderDeps>
  dispose?: ProviderDisposeType<ProviderType, ProviderDeps> = undefined

  constructor() {
    this.factory = notImplemented()
  }

  withDependencies<Deps extends Dependencies>(newDependencies: Deps) {
    this.dependencies = merge(this.dependencies, newDependencies)
    return this as unknown as Provider<
      ProviderType,
      ProviderDeps & Deps,
      ProviderScope
    >
  }

  withScope<T extends Scope>(scope: T) {
    this.scope = scope as unknown as ProviderScope
    return this as unknown as Provider<ProviderType, ProviderDeps, T>
  }

  withFactory<F extends ProviderFactoryType<ProviderType, ProviderDeps>>(
    factory: F,
  ) {
    this.value = undefined as unknown as ProviderType
    this.factory = factory
    return this as unknown as Provider<
      Awaited<ReturnType<F>>,
      ProviderDeps,
      ProviderScope
    >
  }

  withValue<T extends null extends ProviderType ? any : ProviderType>(
    value: T,
  ) {
    this.factory = undefined as unknown as ProviderFactoryType<
      ProviderType,
      ProviderDeps
    >
    this.dispose = undefined
    this.value = value as unknown as ProviderType
    return this as unknown as Provider<
      null extends ProviderType ? T : ProviderType,
      ProviderDeps,
      ProviderScope
    >
  }

  withDisposal(dispose: this['dispose']) {
    this.dispose = dispose
    return this
  }

  $withType<T>() {
    return this as unknown as Provider<T, ProviderDeps>
  }

  asOptional() {
    return {
      [OptionalDependency]: true,
      provider: this,
    } as const
  }

  resolve(
    ...args: keyof ProviderDeps extends never
      ? []
      : [DependencyContext<ProviderDeps>]
  ) {
    if (this.value) return this.value
    const [ctx = {}] = args
    return this.factory(ctx as any)
  }
}

export class Container {
  readonly instances = new Map<AnyProvider, any>()
  private readonly resolvers = new Map<AnyProvider, Promise<any>>()
  private readonly providers = new Set<AnyProvider>()
  private readonly depender = new Map<Depender | AnyProvider, Set<Provider>>()

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
        const provider = getDepedencencyProvider(dependency)
        this.providers.add(provider)
        traverse(provider.dependencies)
      }
    }

    for (const depender of this.getGlobals()) {
      traverse(depender.dependencies)
    }

    const providers = this.findCurrentScopeDeclarations()
    await Promise.all(providers.map((provider) => this.resolve(provider)))
  }

  createScope(scope: Scope) {
    return new Container(this.application, scope, this)
  }

  async dispose() {
    // TODO: here might need to find correct order of disposing
    // to prevent first disposal of a provider
    // that other providers depends on
    this.application.logger.trace('Disposing [%s] scope context...', this.scope)
    const instances = Array.from(this.instances.entries()).reverse()
    for (const [{ dispose, dependencies }, value] of instances) {
      if (dispose) {
        try {
          const ctx = await this.createContext(dependencies)
          await dispose(value, ctx)
        } catch (cause) {
          this.application.logger.error(
            new Error('Context disposal error. Potential memory leak', {
              cause,
            }),
          )
        }
      }
    }
    this.instances.clear()
    this.providers.clear()
    this.resolvers.clear()
  }

  isResolved(provider: AnyProvider): boolean {
    return !!(
      this.instances.has(provider) ||
      this.resolvers.has(provider) ||
      this.parent?.isResolved(provider)
    )
  }

  resolve<T extends AnyProvider>(provider: T): Promise<ResolveProviderType<T>> {
    if (this.instances.has(provider)) {
      return Promise.resolve(this.instances.get(provider)!)
    } else if (this.resolvers.has(provider)) {
      return this.resolvers.get(provider)!
    } else {
      const { value, factory, scope, dependencies } = provider
      if (typeof value !== 'undefined') return Promise.resolve(value)
      if (this.parent?.isResolved(provider))
        return this.parent.resolve(provider)
      const resolution = this.createContext(dependencies)
        .then((ctx) => factory(ctx))
        .then((instance) => {
          if (ScopeStrictness[this.scope] >= ScopeStrictness[scope])
            this.instances.set(provider, instance)
          if (scope !== Scope.Transient) this.resolvers.delete(provider)
          return instance
        })
      if (scope !== Scope.Transient) this.resolvers.set(provider, resolution)
      return resolution
    }
  }

  async createContext<T extends Dependencies>(dependencies: T) {
    const injections = await this.resolveDependecies(dependencies)
    return Object.freeze(injections)
  }

  async provide<T extends AnyProvider>(
    provider: T,
    value: ResolveProviderType<T>,
  ) {
    this.instances.set(provider, value)
  }

  private async resolveDependecies<T extends Dependencies>(dependencies: T) {
    const injections: any = {}
    const resolvers: Promise<any>[] = []
    for (const [key, dependency] of Object.entries(dependencies)) {
      const provider = getDepedencencyProvider(dependency)
      const resolver = this.resolve(provider)
      resolvers.push(resolver.then((value) => (injections[key] = value)))
    }
    await Promise.all(resolvers)
    return injections as DependencyContext<T>
  }

  private findCurrentScopeDeclarations() {
    const declarations: AnyProvider[] = []
    for (const provider of this.providers) {
      if (getProviderScope(provider) === this.scope) {
        declarations.push(provider)
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
      }
    }
  }
}

// TODO: this could be moved to Provide.withDependencies(),
// so there's runtime overhead
export function getProviderScope(provider: AnyProvider) {
  let scope = provider.scope
  for (const dependency of Object.values(
    provider.dependencies as Dependencies,
  )) {
    const provider = getDepedencencyProvider(dependency)
    const dependencyScope = getProviderScope(provider)
    if (ScopeStrictness[dependencyScope] > ScopeStrictness[scope]) {
      scope = dependencyScope
    }
  }
  return scope
}

export function getDepedencencyProvider(
  dependency: Depedency | DependencyOptional,
): AnyProvider {
  return OptionalDependency in dependency ? dependency.provider : dependency
}

const notImplemented = () => () => {
  throw new Error(`Provider's factory is not implemented`)
}
