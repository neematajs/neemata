import type { PerformanceMeasure } from 'node:perf_hooks'
import assert from 'node:assert'

import { tryCaptureStackTrace } from '@nmtjs/common'

import type {
  AnyInjectable,
  Dependencies,
  DependencyContext,
  Injection,
  ResolveInjectableType,
} from './injectables.ts'
import type { Logger } from './logger.ts'
import { Scope } from './enums.ts'
import {
  CoreInjectables,
  compareScope,
  createValueInjectable,
  getDepedencencyInjectable,
  isFactoryInjectable,
  isInjectable,
  isLazyInjectable,
  isOptionalInjectable,
  isValueInjectable,
  provision,
} from './injectables.ts'

type InstanceWrapper = { private: any; public: any; context: any }

type ContainerOptions = { logger: Logger }

export class Container {
  readonly instances = new Map<AnyInjectable, InstanceWrapper[]>()
  private readonly resolvers = new Map<AnyInjectable, Promise<any>>()
  private readonly injectables = new Set<AnyInjectable>()
  private readonly dependants = new Map<AnyInjectable, Set<AnyInjectable>>()
  private readonly provisions = new Map<AnyInjectable, any>()
  private disposing = false

  constructor(
    private readonly runtime: ContainerOptions,
    public readonly scope: Exclude<Scope, Scope.Transient> = Scope.Global,
    private readonly parent?: Container,
  ) {
    if ((scope as any) === Scope.Transient) {
      throw new Error('Invalid scope')
    }
    this.provide(CoreInjectables.inject, this.createInjectFunction())
    this.provide(CoreInjectables.dispose, this.createDisposeFunction())
  }

  async initialize(injectables: Iterable<AnyInjectable>) {
    const measurements: PerformanceMeasure[] = []

    const traverse = (dependencies: Dependencies) => {
      for (const key in dependencies) {
        const dependency = dependencies[key]
        const injectable = getDepedencencyInjectable(dependency)
        if (injectable.scope === this.scope) {
          this.injectables.add(injectable)
        }
        traverse(injectable.dependencies)
      }
    }

    for (const dependant of injectables) {
      traverse(dependant.dependencies)
    }

    await Promise.all(
      [...this.injectables].map((injectable) =>
        this.resolve(injectable, measurements),
      ),
    )

    return measurements
  }

  fork(scope: Exclude<Scope, Scope.Transient>) {
    return new Container(this.runtime, scope, this)
  }

  find(scope: Exclude<Scope, Scope.Transient>): Container | undefined {
    if (this.scope === scope) {
      return this
    } else {
      return this.parent?.find(scope)
    }
  }

  async [Symbol.asyncDispose]() {
    await this.dispose()
  }

  async dispose() {
    this.runtime.logger.trace('Disposing [%s] scope context...', this.scope)

    // Prevent new resolutions during disposal
    this.disposing = true

    // Get proper disposal order using topological sort
    const disposalOrder = this.getDisposalOrder()

    try {
      // Dispose in the correct order
      for (const injectable of disposalOrder) {
        if (this.instances.has(injectable)) {
          await this.disposeInjectableInstances(injectable)
        }
      }
    } catch (error) {
      this.runtime.logger.fatal(
        { error },
        'Potential memory leak: error during container disposal',
      )
    }

    this.instances.clear()
    this.injectables.clear()
    this.resolvers.clear()
    this.dependants.clear()

    this.disposing = false
  }

  containsWithinSelf(injectable: AnyInjectable) {
    return (
      this.provisions.has(injectable) ||
      this.instances.has(injectable) ||
      this.resolvers.has(injectable)
    )
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

    if (this.provisions.has(injectable)) {
      return this.provisions.get(injectable)
    }

    if (this.instances.has(injectable)) {
      return this.instances.get(injectable)!.at(0)!.public
    }

    if (this.parent?.contains(injectable)) {
      return this.parent.get(injectable)
    }

    throw new Error('No instance found')
  }

  resolve<T extends AnyInjectable>(
    injectable: T,
    measurements?: PerformanceMeasure[],
  ) {
    return this.resolveInjectable(
      injectable,
      undefined,
      undefined,
      measurements,
    )
  }

  async createContext<T extends Dependencies>(dependencies: T) {
    return this.createInjectableContext(dependencies)
  }

  provide<T extends Injection[]>(injections: T): void
  provide<T extends AnyInjectable>(
    injectable: T,
    value: ResolveInjectableType<T> | AnyInjectable<ResolveInjectableType<T>>,
  ): void
  provide<T extends AnyInjectable | Injection[]>(
    injectable: T,
    ...[value]: T extends AnyInjectable
      ? [
          value:
            | ResolveInjectableType<T>
            | AnyInjectable<ResolveInjectableType<T>>,
        ]
      : []
  ) {
    const injections = Array.isArray(injectable)
      ? injectable
      : [provision(injectable, value)]
    for (const { token, value } of injections) {
      if (compareScope(token.scope, '>', this.scope)) {
        // TODO: more informative error
        throw new Error('Invalid scope')
      }
      this.provisions.set(token, value)
    }
  }

  withhold(...injectables: AnyInjectable[]) {
    for (const injectable of injectables) {
      this.provisions.delete(injectable)
    }
  }

  satisfies(injectable: AnyInjectable) {
    return compareScope(injectable.scope, '<=', this.scope)
  }

  async disposeInjectableInstances(injectable: AnyInjectable) {
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
      this.runtime.logger.error(error)
    } finally {
      this.instances.delete(injectable)
    }
  }

  async disposeInjectableInstance(
    injectable: AnyInjectable,
    instance: any,
    context: any,
  ) {
    if (isFactoryInjectable(injectable)) {
      const { dispose } = injectable
      if (dispose) await dispose(instance, context)
    }
  }

  private async createInjectableContext<T extends Dependencies>(
    dependencies: T,
    dependant?: AnyInjectable,
    measurements?: PerformanceMeasure[],
  ) {
    const injections: Record<string, any> = {}
    const deps = Object.entries(dependencies)
    const resolvers: Promise<any>[] = Array(deps.length)
    for (let i = 0; i < deps.length; i++) {
      const [key, dependency] = deps[i]
      const isOptional = isOptionalInjectable(dependency)
      const injectable = getDepedencencyInjectable(dependency)
      const resolver = this.resolveInjectable(
        injectable,
        dependant,
        isOptional,
        measurements,
      )
      resolvers[i] = resolver.then((value) => (injections[key] = value))
    }
    await Promise.all(resolvers)
    return Object.freeze(injections) as DependencyContext<T>
  }

  private resolveInjectable<T extends AnyInjectable>(
    injectable: T,
    dependant?: AnyInjectable,
    isOptional?: boolean,
    measurements?: PerformanceMeasure[],
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

    if (this.provisions.has(injectable)) {
      const provided = this.provisions.get(injectable)
      if (isInjectable(provided)) {
        return this.resolveInjectable(
          provided,
          dependant,
          isOptional,
          measurements,
        )
      } else {
        return Promise.resolve(provided)
      }
    } else if (isValueInjectable(injectable)) {
      return Promise.resolve(injectable.value)
    } else if (
      this.parent?.contains(injectable) ||
      (this.parent?.satisfies(injectable) &&
        compareScope(this.parent.scope, '<', this.scope))
    ) {
      return this.parent.resolveInjectable(
        injectable,
        dependant,
        undefined,
        measurements,
      )
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
          if (isOptional) return Promise.resolve(undefined as any)
          return Promise.reject(
            new Error(
              `No instance provided for ${label || 'an'} injectable:\n${stack}`,
            ),
          )
        } else {
          const measure = measurements
            ? performance.measure(injectable.label || injectable.stack || '')
            : null
          const resolution = this.createResolution(
            injectable,
            measurements,
          ).finally(() => {
            this.resolvers.delete(injectable)

            // biome-ignore lint: false
            // @ts-ignore
            if (measurements && measure) measurements.push(measure)
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
    measurements?: PerformanceMeasure[],
  ): Promise<ResolveInjectableType<T>> {
    const { dependencies } = injectable
    const context = await this.createInjectableContext(
      dependencies,
      injectable,
      measurements,
    )
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
      scope: Exclude<Scope, Scope.Transient> = this.scope,
    ) => {
      const container = this.find(scope)
      if (!container)
        throw new Error('No container found for the specified scope')

      const dependencies: Dependencies = { ...injectable.dependencies }

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
        stack: tryCaptureStackTrace(1),
      }

      return container.resolve(newInjectable) as Promise<
        ResolveInjectableType<T>
      >
    }

    const explicit = async <T extends AnyInjectable>(
      injectable: T,
      context: InlineInjectionDependencies<T>,
      scope: Exclude<Scope, Scope.Transient> = this.scope,
    ) => {
      if ('asyncDispose' in Symbol === false) {
        throw new Error(
          'Symbol.asyncDispose is not supported in this environment',
        )
      }

      const container = this.find(scope)
      if (!container)
        throw new Error('No container found for the specified scope')

      const instance = await inject(injectable, context)
      const dispose = container.createDisposeFunction()

      return {
        instance,
        [Symbol.asyncDispose]: async () => {
          await dispose(injectable, instance)
        },
      }
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
}

type InlineInjectionDependencies<T extends AnyInjectable> = {
  [K in keyof T['dependencies']]?:
    | ResolveInjectableType<T['dependencies'][K]>
    | AnyInjectable<ResolveInjectableType<T['dependencies'][K]>>
}

export type InjectFn = ReturnType<Container['createInjectFunction']>
export type DisposeFn = ReturnType<Container['createDisposeFunction']>
