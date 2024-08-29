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

export interface Dependant<Deps extends Dependencies = Dependencies> {
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
> extends Dependant<ProviderDeps> {
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
  factory!: ProviderFactoryType<ProviderType, ProviderDeps>
  dispose?: ProviderDisposeType<ProviderType, ProviderDeps> = undefined

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

  withDispose(dispose: this['dispose']) {
    this.dispose = dispose
    return this
  }

  $withType<T>() {
    return this as unknown as Provider<T, ProviderDeps>
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
  readonly instances = new Map<AnyProvider, { instance: any; context: any }>()
  private readonly resolvers = new Map<AnyProvider, Promise<any>>()
  private readonly providers = new Set<AnyProvider>()
  private readonly dependants = new Map<AnyProvider, Set<AnyProvider>>()

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

    for (const dependant of this.getGlobals()) {
      traverse(dependant.dependencies)
    }

    const providers = this.findCurrentScopeDeclarations()
    await Promise.all(providers.map((provider) => this.resolve(provider)))
  }

  createScope(scope: Scope) {
    return new Container(this.application, scope, this)
  }

  async dispose() {
    this.application.logger.trace('Disposing [%s] scope context...', this.scope)

    // Loop through all instances and dispose them,
    // until there are no more instances left
    while (this.instances.size) {
      for (const provider of this.instances.keys()) {
        const dependants = this.dependants.get(provider)
        // Firstly, dispose instances that other providers don't depend on
        if (!dependants?.size) {
          await this.disposeProvider(provider)
          for (const dependants of this.dependants.values()) {
            // Clear current istances as a dependant for other providers
            if (dependants.has(provider)) {
              dependants.delete(provider)
            }
          }
        }
      }
    }

    this.instances.clear()
    this.providers.clear()
    this.resolvers.clear()
    this.dependants.clear()
  }

  has(provider: AnyProvider): boolean {
    return !!(
      this.instances.has(provider) ||
      this.resolvers.has(provider) ||
      this.parent?.has(provider)
    )
  }

  resolve<T extends AnyProvider>(
    provider: T,
    dependant?: AnyProvider,
  ): Promise<ResolveProviderType<T>> {
    if (dependant) {
      let dependants = this.dependants.get(provider)
      if (!dependants) {
        this.dependants.set(provider, (dependants = new Set()))
      }
      dependants.add(dependant)
    }

    if (this.instances.has(provider)) {
      return Promise.resolve(this.instances.get(provider)!.instance)
    } else if (this.resolvers.has(provider)) {
      return this.resolvers.get(provider)!
    } else {
      const { value, factory, scope, dependencies } = provider
      if (typeof value !== 'undefined') return Promise.resolve(value)

      if (this.parent?.has(provider)) return this.parent.resolve(provider)
      const isOptional = checkOptional(provider)
      const hasFactory = typeof factory !== 'undefined'

      if (!hasFactory) {
        if (isOptional) return Promise.resolve(undefined as any)
        return Promise.reject(new Error(`Missing dependency`))
      }

      const resolution = this.createContext(dependencies, provider)
        .then((context) =>
          Promise.resolve(factory(context)).then((instance) => ({
            instance,
            context,
          })),
        )
        .then(({ instance, context }) => {
          if (ScopeStrictness[this.scope] >= ScopeStrictness[scope])
            this.instances.set(provider, { instance, context })
          if (scope !== Scope.Transient) this.resolvers.delete(provider)
          return instance
        })
      if (scope !== Scope.Transient) this.resolvers.set(provider, resolution)
      return resolution
    }
  }

  async createContext<T extends Dependencies>(
    dependencies: T,
    dependant?: AnyProvider,
  ) {
    const injections: Record<string, any> = {}
    const deps = Object.entries(dependencies)
    const resolvers: Promise<any>[] = Array(deps.length)
    for (let i = 0; i < deps.length; i++) {
      const [key, dependency] = deps[i]
      const provider = getDepedencencyProvider(dependency)
      const resolver = this.resolve(provider, dependant)
      resolvers[i] = resolver.then((value) => (injections[key] = value))
    }
    await Promise.all(resolvers)
    return Object.freeze(injections as DependencyContext<T>)
  }

  async provide<T extends AnyProvider>(
    provider: T,
    instance: ResolveProviderType<T>,
  ) {
    this.instances.set(provider, { instance, context: undefined })
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

  private async disposeProvider(provider: AnyProvider) {
    const { dispose } = provider
    try {
      if (dispose) {
        const { instance, context } = this.instances.get(provider)!
        await dispose(instance, context)
      }
    } catch (cause) {
      const error = new Error(
        'Provider disposal error. Potential memory leak',
        { cause },
      )
      this.application.logger.error(error)
    } finally {
      this.instances.delete(provider)
    }
  }
}

// TODO: this could be moved to Provide.withDependencies(),
// so there's no runtime overhead
export function getProviderScope(provider: AnyProvider) {
  let scope = provider.scope
  const deps = Object.values(provider.dependencies as Dependencies)
  for (const dependency of deps) {
    const provider = getDepedencencyProvider(dependency)
    const dependencyScope = getProviderScope(provider)
    if (ScopeStrictness[dependencyScope] > ScopeStrictness[scope]) {
      scope = dependencyScope
    }
  }
  return scope
}

export function getDepedencencyProvider(dependency: Depedency): AnyProvider {
  if (OptionalDependency in dependency) {
    return dependency.provider
  }
  return dependency
}

function checkOptional(provider: Depedency) {
  return OptionalDependency in provider
}

export function asOptional<T extends AnyProvider>(provider: T) {
  return {
    [OptionalDependency]: true,
    provider,
  } as const
}
