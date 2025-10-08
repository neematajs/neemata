import assert from 'node:assert'

import type { ClassInstance } from '@nmtjs/common'
import { tryCaptureStackTrace } from '@nmtjs/common'

import type {
  AnyInjectable,
  ClassInjectable,
  Dependencies,
  DependencyContext,
  ResolveInjectableType,
} from './injectables.ts'
import type { Logger } from './logger.ts'
import type { Registry } from './registry.ts'
import { kClassInjectableCreate, kClassInjectableDispose } from './constants.ts'
import { Scope } from './enums.ts'
import {
  CoreInjectables,
  compareScope,
  createExtendableClassInjectable,
  createValueInjectable,
  getDepedencencyInjectable,
  isClassInjectable,
  isFactoryInjectable,
  isInjectable,
  isLazyInjectable,
  isOptionalInjectable,
  isValueInjectable,
} from './injectables.ts'

type InstanceWrapper = { private: any; public: any; context: any }

type ContainerOptions = { registry: Registry; logger: Logger }

export class Container {
  readonly instances = new Map<AnyInjectable, InstanceWrapper[]>()
  private readonly resolvers = new Map<AnyInjectable, Promise<any>>()
  private readonly injectables = new Set<AnyInjectable>()
  private readonly dependants = new Map<AnyInjectable, Set<AnyInjectable>>()
  // private readonly transients = new Map<any, any>()
  private disposing = false

  constructor(
    private readonly application: ContainerOptions,
    public readonly scope: Exclude<Scope, Scope.Transient> = Scope.Global,
    private readonly parent?: Container,
  ) {
    if ((scope as any) === Scope.Transient) {
      throw new Error('Invalid scope')
    }
    this.provide(CoreInjectables.inject, this.createInjectFunction())
    this.provide(CoreInjectables.dispose, this.createDisposeFunction())
    this.provide(CoreInjectables.registry, application.registry)
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
        await this.disposeInjectableInstances(injectable)
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
    if (injectable.scope === Scope.Transient) {
      throw new Error('Cannot get transient injectable directly')
    }

    if (this.instances.has(injectable)) {
      return this.instances.get(injectable)!.at(0)!.public
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

    this.instances.set(injectable, [
      { private: instance, public: instance, context: undefined },
    ])
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
      return Promise.reject(new Error('Cannot resolve during disposal'))
    }

    if (dependant && compareScope(dependant.scope, '<', injectable.scope)) {
      // TODO: more informative error
      return Promise.reject(
        new Error('Invalid scope: dependant is looser than injectable'),
      )
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

      const isTransient = injectable.scope === Scope.Transient

      if (!isTransient && this.instances.has(injectable)) {
        return Promise.resolve(this.instances.get(injectable)!.at(0)!.public)
      } else if (!isTransient && this.resolvers.has(injectable)) {
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
          const resolution = this.createResolution(injectable).finally(() => {
            this.resolvers.delete(injectable)
          })
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
    const { dependencies } = injectable
    const context = await this.createInjectableContext(dependencies, injectable)
    const wrapper = {
      private: null as any,
      public: null as ResolveInjectableType<T>,
      context,
    }
    if (isFactoryInjectable(injectable)) {
      wrapper.private = await Promise.resolve(
        injectable.factory(wrapper.context),
      )
      wrapper.public = injectable.pick(wrapper.private)
    } else if (isClassInjectable(injectable)) {
      const instance: ClassInstance<ClassInjectable<unknown>> = new injectable(
        context,
      )
      wrapper.private = instance
      wrapper.public = wrapper.private
      await instance[kClassInjectableCreate]?.call(instance)
    } else {
      throw new Error('Invalid injectable type')
    }

    let instances = this.instances.get(injectable)

    if (!instances) {
      instances = []
      this.instances.set(injectable, instances)
    }
    instances.push(wrapper)

    return wrapper.public
  }

  private createInjectFunction() {
    const inject = <T extends AnyInjectable>(
      injectable: T,
      context: InlineInjectionDependencies<T>,
    ) => {
      const dependencies: Dependencies = { ...injectable.dependencies }

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
            1,
          )
        : {
            ...injectable,
            dependencies,
            scope: Scope.Transient,
            stack: tryCaptureStackTrace(1),
          }

      return this.resolve(newInjectable) as Promise<ResolveInjectableType<T>>
    }

    const explicit = async <T extends AnyInjectable>(
      injectable: T,
      context: InlineInjectionDependencies<T>,
    ) => {
      if ('asyncDispose' in Symbol === false) {
        throw new Error(
          'Symbol.asyncDispose is not supported in this environment',
        )
      }
      const instance = await inject(injectable, context)
      const dispose = this.createDisposeFunction()
      return Object.assign(instance, {
        [Symbol.asyncDispose]: async () => {
          await dispose(injectable, instance)
        },
      })
    }

    return Object.assign(inject, { explicit })
  }

  private createDisposeFunction() {
    return async <T extends AnyInjectable>(injectable: T, instance?: any) => {
      if (injectable.scope === Scope.Transient) {
        assert(
          instance,
          'Instance is required for transient injectable disposal',
        )
        const wrappers = this.instances.get(injectable)
        if (wrappers) {
          for (const wrapper of wrappers) {
            if (wrapper.public === instance) {
              await this.disposeInjectableInstance(
                injectable,
                wrapper.private,
                wrapper.context,
              )
              const index = wrappers.indexOf(wrapper)
              wrappers.splice(index, 1)
            }
          }

          if (wrappers.length === 0) {
            this.instances.delete(injectable)
          }
        }
      } else {
        await this.disposeInjectableInstances(injectable)
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

  private async disposeInjectableInstances(injectable: AnyInjectable) {
    try {
      if (this.instances.has(injectable)) {
        const wrappers = this.instances.get(injectable)!
        await Promise.all(
          wrappers.map((wrapper) =>
            this.disposeInjectableInstance(
              injectable,
              wrapper.private,
              wrapper.context,
            ),
          ),
        )
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
      if (dispose) await dispose(instance, context)
    } else if (isClassInjectable(injectable)) {
      await instance[kClassInjectableDispose]()
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
