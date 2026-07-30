import assert from 'node:assert'

import type { StackTraceAnchor } from '@nmtjs/common'
import { tryCaptureStackTrace } from '@nmtjs/common'

import type {
  AnyInjectable,
  Dependencies,
  DependencyContext,
  Provision,
  ProvisionValue,
  ResolveInjectableType,
} from './injectables.ts'
import type { Logger } from './logger.ts'
import { Scope } from './enums.ts'
import {
  CoreInjectables,
  compareScope,
  createValueInjectable,
  getDepedencencyInjectable,
  getEffectiveInjectableScope,
  isFactoryInjectable,
  isInjectable,
  isLazyInjectable,
  isOptionalInjectable,
  isValueInjectable,
  provision,
} from './injectables.ts'

/**
 * A created instance together with everything needed to dispose it.
 * Disposal state travels with the handle instead of being re-derived
 * from identity lookups, which breaks down when injectables get cloned.
 */
type InstanceHandle = {
  injectable: AnyInjectable
  private: any
  public: any
  context: any
}

type ProvisionEntry =
  | { kind: 'value'; value: any }
  // a provided injectable: resolution and instance caching happen under the
  // target, so direct users of the target share the same instance
  | { kind: 'alias'; target: AnyInjectable }

export type ResolutionEvent = {
  injectable: AnyInjectable
  scope: Exclude<Scope, Scope.Transient>
  durationMs: number
  error?: unknown
}

export type ContainerOptions = {
  logger: Logger
  onResolution?: (event: ResolutionEvent) => void
}

/**
 * Per-path resolution state. Threaded explicitly through the resolver so
 * facts like optionality and the dependency path survive delegation across
 * containers and provision indirections.
 */
type ResolutionRequest = {
  readonly dependant?: AnyInjectable
  readonly optional?: boolean
  readonly chain: readonly AnyInjectable[]
}

const label = (injectable: AnyInjectable) => injectable.label || '<anonymous>'

export class Container {
  readonly instances = new Map<AnyInjectable, InstanceHandle[]>()
  protected readonly provisions = new Map<AnyInjectable, ProvisionEntry>()

  // scan index for individual transient disposal by instance identity
  protected readonly transientHandles = new Set<InstanceHandle>()
  protected readonly resolving = new Map<AnyInjectable, Promise<any>>()

  // every in-flight resolution, including transient ones absent from `resolving`
  protected readonly pending = new Set<Promise<any>>()
  protected readonly dependants = new Map<AnyInjectable, Set<AnyInjectable>>()

  protected disposing = false

  constructor(
    protected readonly runtime: ContainerOptions,
    public readonly scope: Exclude<Scope, Scope.Transient> = Scope.Global,
    protected readonly parent?: Container,
  ) {
    if ((scope as Scope) === Scope.Transient) throw new Error('Invalid scope')
    this.provide(CoreInjectables.inject, this.createInjectFunction())
    this.provide(CoreInjectables.dispose, this.createDisposeFunction())
  }

  async initialize(injectables: Iterable<AnyInjectable>) {
    // an injectable is preloaded as optional only if no dependant requires it
    const optionality = new Map<AnyInjectable, boolean>()
    const visited = new Set<AnyInjectable>()

    const traverse = (dependencies: Dependencies) => {
      for (const key in dependencies) {
        const dependency = dependencies[key]
        const injectable = getDepedencencyInjectable(dependency)
        if (injectable.scope === this.scope) {
          optionality.set(
            injectable,
            (optionality.get(injectable) ?? true) &&
              isOptionalInjectable(dependency),
          )
        }
        if (visited.has(injectable)) continue
        visited.add(injectable)
        traverse(injectable.dependencies)
      }
    }

    for (const dependant of injectables) {
      traverse(dependant.dependencies)
    }

    await Promise.all(
      [...optionality].map(([injectable, optional]) =>
        this.resolveInjectable(injectable, { optional, chain: [] }),
      ),
    )
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

    // Let in-flight resolutions settle first, otherwise their instances get
    // registered after the cleanup below and are never disposed
    while (this.pending.size) {
      await Promise.allSettled([...this.pending])
    }

    // Get proper disposal order using topological sort
    const disposalOrder = this.getDisposalOrder()

    try {
      // Dispose in the correct order
      for (const injectable of disposalOrder) {
        await this.disposeInjectableInstances(injectable)
      }
    } catch (error) {
      this.runtime.logger.fatal(
        { error },
        'Potential memory leak: error during container disposal',
      )
    }

    this.instances.clear()
    this.transientHandles.clear()
    this.resolving.clear()
    this.dependants.clear()

    this.disposing = false
  }

  owns(injectable: AnyInjectable) {
    return (
      this.provisions.has(injectable) ||
      this.instances.has(injectable) ||
      this.resolving.has(injectable)
    )
  }

  contains(injectable: AnyInjectable): boolean {
    return this.owns(injectable) || (this.parent?.contains(injectable) ?? false)
  }

  has(injectable: AnyInjectable) {
    return this.instances.has(injectable)
  }

  get<T extends AnyInjectable>(injectable: T): ResolveInjectableType<T> {
    if (injectable.scope === Scope.Transient) {
      throw new Error('Cannot get transient injectable directly')
    }

    // follow provision aliases to the actual instance holder
    let target: AnyInjectable = injectable
    const seen = new Set<AnyInjectable>()
    while (!seen.has(target)) {
      seen.add(target)
      const provided = this.provisions.get(target)
      if (!provided) break
      if (provided.kind === 'value') return provided.value
      target = provided.target
    }

    if (isValueInjectable(target)) return target.value

    const handle = this.instances.get(target)?.at(0)
    if (handle) return handle.public

    if (this.parent?.contains(target)) {
      return this.parent.get(target as T)
    }

    throw new Error(`No instance found for ${label(injectable)} injectable`)
  }

  resolve<T extends AnyInjectable>(
    injectable: T,
  ): Promise<ResolveInjectableType<T>> {
    return this.resolveInjectable(injectable, { chain: [] })
  }

  async createContext<T extends Dependencies>(dependencies: T) {
    return this.createDependencyContext(dependencies, { chain: [] })
  }

  provide<T extends Provision[]>(provisions: T): void
  provide<T extends AnyInjectable>(
    injectable: T,
    value: ProvisionValue<T>,
  ): void
  provide<T extends AnyInjectable | Provision[]>(
    injectable: T,
    ...[value]: T extends AnyInjectable ? [value: ProvisionValue<T>] : []
  ) {
    const provisions = Array.isArray(injectable)
      ? injectable
      : [provision(injectable, value)]
    for (const { token, value } of provisions) {
      this.assertProvidable(token, value)
      this.provisions.set(
        token,
        isInjectable(value)
          ? { kind: 'alias', target: value }
          : { kind: 'value', value },
      )
    }
  }

  withhold(...injectables: AnyInjectable[]) {
    for (const injectable of injectables) {
      this.provisions.delete(injectable)
    }
  }

  satisfies(injectable: AnyInjectable) {
    return compareScope(
      getEffectiveInjectableScope(injectable),
      '<=',
      this.scope,
    )
  }

  async disposeInjectableInstances(injectable: AnyInjectable) {
    const handles = this.instances.get(injectable)
    if (!handles) return
    try {
      const disposals: Promise<void>[] = Array(handles.length)
      for (let i = 0; i < handles.length; i++) {
        disposals[i] = this.disposeHandle(handles[i])
      }
      const results = await Promise.allSettled(disposals)
      for (const result of results) {
        if (result.status === 'rejected') {
          const error = new Error(
            'Injectable disposal error. Potential memory leak',
            { cause: result.reason },
          )
          this.runtime.logger.error(error)
        }
      }
    } finally {
      this.instances.delete(injectable)
    }
  }

  protected async disposeHandle(handle: InstanceHandle) {
    this.transientHandles.delete(handle)
    const { injectable } = handle
    if (isFactoryInjectable(injectable) && injectable.dispose) {
      await injectable.dispose(handle.private, handle.context)
    }
  }

  protected assertProvidable(token: AnyInjectable, value: any) {
    const tokenScope = getEffectiveInjectableScope(token)
    if (compareScope(tokenScope, '>', this.scope)) {
      throw new Error(
        `Cannot provide ${label(token)} injectable: its scope [${tokenScope}] is stricter than the container scope [${this.scope}]`,
      )
    }
    if (isInjectable(value)) {
      const targetScope = getEffectiveInjectableScope(value)
      if (compareScope(targetScope, '>', this.scope)) {
        throw new Error(
          `Cannot provide ${label(value)} injectable for ${label(token)}: its scope [${targetScope}] is stricter than the container scope [${this.scope}]`,
        )
      }
    }
  }

  // runs on every procedure call — plain loops, no iterator closures
  protected async createDependencyContext<T extends Dependencies>(
    dependencies: T,
    request: ResolutionRequest,
  ) {
    const keys = Object.keys(dependencies)
    const resolutions: Promise<any>[] = Array(keys.length)
    for (let i = 0; i < keys.length; i++) {
      const dependency = dependencies[keys[i]]
      resolutions[i] = this.resolveInjectable(
        getDepedencencyInjectable(dependency),
        {
          dependant: request.dependant,
          optional: isOptionalInjectable(dependency),
          chain: request.chain,
        },
      )
    }
    const values = await Promise.all(resolutions)
    const injections: Record<string, any> = {}
    for (let i = 0; i < keys.length; i++) {
      injections[keys[i]] = values[i]
    }
    return Object.freeze(injections) as DependencyContext<T>
  }

  protected resolveInjectable<T extends AnyInjectable>(
    injectable: T,
    request: ResolutionRequest,
  ): Promise<ResolveInjectableType<T>> {
    if (this.disposing) {
      return Promise.reject(new Error('Cannot resolve during disposal'))
    }

    if (request.chain.includes(injectable)) {
      return Promise.reject(this.createCircularityError(injectable, request))
    }

    // the dependency graph is frozen at declaration time, so this can only
    // fire through runtime indirections such as provision aliases
    if (request.dependant) {
      const dependantScope = getEffectiveInjectableScope(request.dependant)
      const injectableScope = getEffectiveInjectableScope(injectable)
      if (compareScope(dependantScope, '<', injectableScope)) {
        return Promise.reject(
          new Error(
            `Invalid scope: ${label(request.dependant)} injectable [${dependantScope}] cannot depend on ${label(injectable)} injectable with stricter scope [${injectableScope}]`,
          ),
        )
      }
    }

    const provided = this.provisions.get(injectable)
    if (provided) {
      if (provided.kind === 'value') return Promise.resolve(provided.value)
      return this.resolveInjectable(provided.target, {
        ...request,
        chain: [...request.chain, injectable],
      })
    }

    if (isValueInjectable(injectable)) {
      return Promise.resolve(injectable.value)
    }

    const isTransient = injectable.scope === Scope.Transient

    // delegate upward when an ancestor already has it, or when a strictly
    // looser ancestor can host it; transients always belong to the
    // requesting container so their lifetime matches the request's scope
    if (
      !isTransient &&
      this.parent &&
      (this.parent.contains(injectable) ||
        (this.parent.satisfies(injectable) &&
          compareScope(this.parent.scope, '<', this.scope)))
    ) {
      return this.parent.resolveInjectable(injectable, request)
    }

    // this container owns the resolution: record the dependency edge even on
    // cache hits, disposal ordering needs every edge — not just the first one
    if (request.dependant) {
      let dependants = this.dependants.get(injectable)
      if (!dependants) {
        this.dependants.set(injectable, (dependants = new Set()))
      }
      dependants.add(request.dependant)
    }

    if (!isTransient) {
      const handle = this.instances.get(injectable)?.at(0)
      if (handle) return Promise.resolve(handle.public)

      const inflight = this.resolving.get(injectable)
      if (inflight) return inflight
    }

    if (isLazyInjectable(injectable)) {
      if (request.optional) return Promise.resolve(undefined as any)
      return Promise.reject(
        new Error(
          `No instance provided for ${injectable.label || 'an'} injectable${this.describePath(request)}${injectable.stack ? `\n${injectable.stack}` : ''}`,
        ),
      )
    }

    if (!isFactoryInjectable(injectable)) {
      return Promise.reject(new Error('Invalid injectable type'))
    }

    if (!this.satisfies(injectable)) {
      return Promise.reject(
        new Error(
          `Cannot resolve ${label(injectable)} injectable: its scope [${getEffectiveInjectableScope(injectable)}] is stricter than the container scope [${this.scope}]${this.describePath(request)}`,
        ),
      )
    }

    const started = performance.now()
    const resolution = this.createResolution(injectable, request)
      .then(
        (value) => {
          this.emitResolution(injectable, started)
          return value
        },
        (error) => {
          this.emitResolution(injectable, started, error)
          throw error
        },
      )
      .finally(() => {
        this.resolving.delete(injectable)
        this.pending.delete(resolution)
      })
    this.pending.add(resolution)
    if (!isTransient) this.resolving.set(injectable, resolution)
    return resolution
  }

  protected async createResolution<T extends AnyInjectable>(
    injectable: T,
    request: ResolutionRequest,
  ): Promise<ResolveInjectableType<T>> {
    if (!isFactoryInjectable(injectable)) {
      throw new Error('Invalid injectable type')
    }

    const context = await this.createDependencyContext(
      injectable.dependencies,
      {
        dependant: injectable,
        chain: [...request.chain, injectable],
      },
    )

    const instance = await injectable.create(context)

    let publicInstance: any
    try {
      publicInstance = injectable.pick(instance)
    } catch (error) {
      // don't strand an already created instance when pick fails
      try {
        await injectable.dispose?.(instance, context)
      } catch (disposalError) {
        this.runtime.logger.error(
          { error: disposalError },
          'Injectable disposal error after a failed pick. Potential memory leak',
        )
      }
      throw error
    }

    const handle: InstanceHandle = {
      injectable,
      private: instance,
      public: publicInstance,
      context,
    }

    const isTransient = (injectable.scope as Scope) === Scope.Transient

    // transients without a dispose hook need no tracking at all — storing
    // them would only grow memory on long-lived containers
    if (!isTransient || injectable.dispose) {
      let handles = this.instances.get(injectable)
      if (!handles) {
        this.instances.set(injectable, (handles = []))
      }
      handles.push(handle)
      if (isTransient) this.transientHandles.add(handle)
    }

    return handle.public
  }

  protected emitResolution(
    injectable: AnyInjectable,
    started: number,
    error?: unknown,
  ) {
    const { onResolution } = this.runtime
    if (!onResolution) return
    try {
      onResolution({
        injectable,
        scope: this.scope,
        durationMs: performance.now() - started,
        error,
      })
    } catch (hookError) {
      this.runtime.logger.error(
        { error: hookError },
        'Container onResolution hook error',
      )
    }
  }

  protected describePath(request: ResolutionRequest) {
    if (!request.chain.length) return ''
    return `\nResolution path: ${request.chain.map(label).join(' -> ')}`
  }

  protected createCircularityError(
    injectable: AnyInjectable,
    request: ResolutionRequest,
  ) {
    const cycle = [
      ...request.chain.slice(request.chain.indexOf(injectable)),
      injectable,
    ]
    return new Error(
      `Circular dependency detected: ${cycle.map(label).join(' -> ')}${injectable.stack ? `\n${injectable.stack}` : ''}`,
    )
  }

  protected createInjectFunction() {
    // instances are registered under the transient clone, not the original
    // injectable, so the clone must travel with the injection for disposal
    const injectTransient = <T extends AnyInjectable>(
      injectable: T,
      context: InlineInjectionDependencies<T>,
      scope: Exclude<Scope, Scope.Transient>,
      anchor: StackTraceAnchor,
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

      const transientInjectable = Object.freeze({
        ...injectable,
        dependencies: Object.freeze(dependencies),
        scope: Scope.Transient,
        stack: tryCaptureStackTrace(anchor),
      }) as unknown as T

      return {
        container,
        injectable: transientInjectable,
        instance: container.resolve(transientInjectable) as Promise<
          ResolveInjectableType<T>
        >,
      }
    }

    const inject = <T extends AnyInjectable>(
      injectable: T,
      context: InlineInjectionDependencies<T>,
      scope: Exclude<Scope, Scope.Transient> = this.scope,
    ) => injectTransient(injectable, context, scope, inject).instance

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

      const {
        container,
        injectable: transientInjectable,
        instance: pending,
      } = injectTransient(injectable, context, scope, explicit)
      const instance = await pending
      const dispose = container.createDisposeFunction()

      return {
        instance,
        [Symbol.asyncDispose]: async () => {
          await dispose(transientInjectable, instance)
        },
      }
    }

    return Object.assign(inject, { explicit })
  }

  protected createDisposeFunction() {
    return async <T extends AnyInjectable>(injectable: T, instance?: any) => {
      if (injectable.scope === Scope.Transient) {
        assert(
          instance !== undefined,
          'Instance is required for transient injectable disposal',
        )
        // match by instance identity: the definition the caller holds may
        // differ from the internal clone the instance was created under
        const matched: InstanceHandle[] = []
        for (const handle of this.transientHandles) {
          if (handle.public === instance) matched.push(handle)
        }
        for (const handle of matched) {
          await this.disposeHandle(handle)
          const handles = this.instances.get(handle.injectable)
          if (handles) {
            const index = handles.indexOf(handle)
            if (index !== -1) handles.splice(index, 1)
            if (handles.length === 0) this.instances.delete(handle.injectable)
          }
        }
      } else {
        await this.disposeInjectableInstances(injectable)
      }
    }
  }

  protected getDisposalOrder(): AnyInjectable[] {
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
