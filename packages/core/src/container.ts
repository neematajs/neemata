import assert from 'node:assert'
import { Scope } from './enums.ts'
import {
  type AnyInjectable,
  CoreInjectables,
  compareScope,
  createExtendableClassInjectable,
  createValueInjectable,
  type Dependencies,
  type DependencyContext,
  getDepedencencyInjectable,
  isClassInjectable,
  isFactoryInjectable,
  isInjectable,
  isLazyInjectable,
  isOptionalInjectable,
  isValueInjectable,
  type ResolveInjectableType,
} from './injectables.ts'
import type { Logger } from './logger.ts'
import type { Registry } from './registry.ts'

export class Container {
  readonly instances = new Map<
    AnyInjectable,
    { instance: any; picked?: any; context?: any }
  >()
  private readonly resolvers = new Map<AnyInjectable, Promise<any>>()
  private readonly injectables = new Set<AnyInjectable>()
  private readonly dependants = new Map<AnyInjectable, Set<AnyInjectable>>()
  private readonly transients = new WeakMap<any, any>()
  private disposing = false

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
    this.provide(CoreInjectables.inject, this.createInjectFunction())
    this.provide(CoreInjectables.dispose, this.createDisposeFunction())
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

    // Prevent new resolutions during disposal
    this.disposing = true

    // Get proper disposal order using topological sort
    const disposalOrder = this.getDisposalOrder()

    // Dispose in the correct order
    for (const injectable of disposalOrder) {
      if (this.instances.has(injectable)) {
        await this.disposeInjectable(injectable)
      }
    }

    this.instances.clear()
    this.injectables.clear()
    this.resolvers.clear()
    this.dependants.clear()

    this.disposing = false
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
    if (this.disposing) {
      throw new Error('Cannot resolve during disposal')
    }

    if (dependant && compareScope(dependant.scope, '<', injectable.scope)) {
      // TODO: more informative error
      throw new Error('Invalid scope: dependant is looser than injectable')
    }

    if (isValueInjectable(injectable)) {
      return Promise.resolve(injectable.value)
    } else if (
      this.parent?.contains(injectable) ||
      (this.parent?.satisfies(injectable) &&
        compareScope(this.parent.scope, '<', this.scope))
    ) {
      return this.parent.resolveInjectable(injectable, dependant)
    } else {
      const { stack, label } = injectable

      if (dependant) {
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
        const isLazy = isLazyInjectable(injectable)

        if (isLazy) {
          const isOptional = isOptionalInjectable(injectable)
          if (isOptional) return Promise.resolve(undefined as any)
          return Promise.reject(
            new Error(
              `No instance provided for ${label || 'an'} injectable:\n${stack}`,
            ),
          )
        } else {
          const resolution = this.createResolution(injectable)
          if (injectable.scope !== Scope.Transient) {
            this.resolvers.set(injectable, resolution)
          }
          return resolution
        }
      }
    }
  }

  private async createResolution<T extends AnyInjectable>(
    injectable: T,
  ): Promise<ResolveInjectableType<T>> {
    const { scope, dependencies } = injectable
    try {
      let result: any
      const context = await this.createInjectableContext(
        dependencies,
        injectable,
      )
      if (isFactoryInjectable(injectable)) {
        const instance = await Promise.resolve(injectable.factory(context))
        const picked = injectable.pick(instance)

        if (compareScope(this.scope, '>=', scope)) {
          this.instances.set(injectable, { instance, picked, context })
        }

        result = picked
      } else if (isClassInjectable(injectable)) {
        const instance = new injectable(context)
        await instance.$onCreate()

        if (compareScope(this.scope, '>=', scope)) {
          this.instances.set(injectable, {
            instance,
            picked: instance,
            context,
          })
        }

        result = instance
      } else {
        throw new Error('Invalid injectable type')
      }

      if (scope === Scope.Transient) {
        this.transients.set(result, context)
      }

      return result
    } catch (error) {
      this.instances.delete(injectable)
      throw error
    } finally {
      if (scope !== Scope.Transient) {
        this.resolvers.delete(injectable)
      }
    }
  }

  private async createInjectFunction() {
    return <T extends AnyInjectable>(
      injectable: T,
      context: InlineInjectionDependencies<T>,
    ) => {
      const dependencies: Dependencies = {
        ...injectable.dependencies,
      }

      for (const key in context) {
        const dep = context[key]
        if (isInjectable(dep) || isOptionalInjectable(dep)) {
          dependencies[key] = dep
        } else {
          dependencies[key] = createValueInjectable(dep)
        }
      }

      const newInjectable = isClassInjectable(injectable)
        ? createExtendableClassInjectable(
            injectable,
            dependencies,
            Scope.Transient,
          )
        : {
            ...injectable,
            dependencies,
            scope: Scope.Transient,
          }

      return this.resolve(newInjectable)
    }
  }

  private async createDisposeFunction() {
    return async <T extends AnyInjectable>(
      injectable: T,
      instance?: ResolveInjectableType<T>,
    ) => {
      if (injectable.scope === Scope.Transient) {
        assert(
          instance,
          'Instance is required for transient injectable disposal',
        )
        if (this.transients.has(instance)) {
          const context = this.transients.get(instance)!
          try {
            await this.disposeInjectableInstance(injectable, instance, context)
          } finally {
            this.transients.delete(instance)
          }
        }
      } else {
        await this.disposeInjectable(injectable)
      }
    }
  }

  private getDisposalOrder(): AnyInjectable[] {
    const visited = new Set<AnyInjectable>()
    const result: AnyInjectable[] = []

    const visit = (injectable: AnyInjectable) => {
      if (visited.has(injectable)) return
      visited.add(injectable)

      const dependants = this.dependants.get(injectable)
      if (dependants) {
        for (const dependant of dependants) {
          if (this.instances.has(dependant)) {
            visit(dependant)
          }
        }
      }

      // Only add to result if this container owns the instance
      if (this.instances.has(injectable)) {
        result.push(injectable)
      }
    }

    for (const injectable of this.instances.keys()) {
      visit(injectable)
    }

    return result
  }

  private async disposeInjectable(injectable: AnyInjectable) {
    try {
      if (this.instances.has(injectable)) {
        const { instance, context } = this.instances.get(injectable)!
        await this.disposeInjectableInstance(injectable, instance, context)
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

  private async disposeInjectableInstance(
    injectable: AnyInjectable,
    instance: any,
    context: any,
  ) {
    if (isFactoryInjectable(injectable)) {
      const { dispose } = injectable
      if (dispose) {
        await dispose(instance, context)
      }
    } else if (isClassInjectable(injectable)) {
      await instance.$onDispose()
    }
  }
}

type InlineInjectionDependencies<T extends AnyInjectable> = {
  [K in keyof T['dependencies']]?:
    | ResolveInjectableType<T['dependencies'][K]>
    | AnyInjectable<ResolveInjectableType<T['dependencies'][K]>>
}

export type InjectFn = ReturnType<Container['createInjectFunction']>
export type DisposeFn = ReturnType<Container['createDisposeFunction']>
