import { Scope } from './enums.ts'
import {
  type AnyInjectable,
  CoreInjectables,
  compareScope,
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
    this.provide(CoreInjectables.inject, createInjectFunction(this))
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

    if (isValueInjectable(injectable)) {
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
        const isLazy = isLazyInjectable(injectable)

        if (isLazy) {
          const isOptional = isOptionalInjectable(injectable)
          if (isOptional) return Promise.resolve(undefined as any)
          return Promise.reject(
            new Error(
              `No instance provided for ${label || 'an'} injectable:\n${stack}`,
            ),
          )
        } else if (isFactoryInjectable(injectable)) {
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
        } else if (isClassInjectable(injectable)) {
          const resolution = this.createInjectableContext(
            dependencies,
            injectable,
          )
            .then((context) => {
              const instance = new injectable(context)
              return instance.$onCreate().then(() => instance)
            })
            .then((instance) => {
              // const picked = injectable.pick(instance)
              if (compareScope(this.scope, '>=', scope))
                this.instances.set(injectable, {
                  instance,
                  picked: instance,
                  context: undefined,
                })
              if (scope !== Scope.Transient) this.resolvers.delete(injectable)
              return instance
            })
          if (scope !== Scope.Transient)
            this.resolvers.set(injectable, resolution)
          return resolution
        } else {
          throw new Error('Invalid injectable type')
        }
      }
    }
  }

  private async disposeInjectable(injectable: AnyInjectable) {
    try {
      if (isFactoryInjectable(injectable)) {
        const { dispose } = injectable
        if (dispose) {
          const { instance, context } = this.instances.get(injectable)!
          await dispose(instance, context)
        }
      } else if (isClassInjectable(injectable)) {
        const { instance } = this.instances.get(injectable)!
        await instance.$onDispose()
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

export function createInjectFunction(container: Container) {
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

    const newInjectable = {
      ...injectable,
      dependencies,
      scope: Scope.Transient,
    }

    return container.resolve(newInjectable)
  }
}

type InlineInjectionDependencies<T extends AnyInjectable> = {
  [K in keyof T['dependencies']]?:
    | ResolveInjectableType<T['dependencies'][K]>
    | AnyInjectable<ResolveInjectableType<T['dependencies'][K]>>
}

export type InjectFn = ReturnType<typeof createInjectFunction>
