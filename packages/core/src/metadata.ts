import type { MaybePromise } from '@nmtjs/common'

import type {
  Dependant,
  Dependencies,
  DependencyContext,
  LazyInjectable,
  ResolveInjectableType,
} from './injectables.ts'
import { kMetaBinding, kMetadata } from './constants.ts'
import { Scope } from './enums.ts'
import {
  createLazyInjectable,
  createOptionalInjectable,
} from './injectables.ts'

export enum MetadataKind {
  STATIC = 'STATIC',
  FACTORY = 'FACTORY',
}

export type MetaPhase = 'beforeDecode' | 'afterDecode'

type MetaBase<Value> = LazyInjectable<Value, Scope.Call> & { [kMetadata]: true }

type MetaToken<Value> = MetaBase<Value>

type MetaStaticCapability<
  Value,
  Kind extends MetadataKind,
> = MetadataKind.STATIC extends Kind
  ? { static(value: Value): StaticMetaBinding<MetaToken<Value>> }
  : {}

type MetaFactoryCapability<
  Value,
  Kind extends MetadataKind,
  Call,
> = MetadataKind.FACTORY extends Kind
  ? { factory: MetaFactoryMethod<Value, Call> }
  : {}

export type Meta<
  Value,
  Kind extends MetadataKind = MetadataKind,
  Call = unknown,
> = MetaBase<Value> &
  MetaStaticCapability<Value, Kind> &
  MetaFactoryCapability<Value, Kind, Call>

export type AnyMeta = MetaBase<any>

type MetaBindingToken<T extends AnyMeta = AnyMeta> = {
  readonly [kMetaBinding]: T
}

export interface StaticMetaBinding<T extends AnyMeta = AnyMeta>
  extends Dependant<{}>,
    MetaBindingToken<T> {
  readonly kind: MetadataKind.STATIC
  readonly value: ResolveInjectableType<T>
}

export interface MetaFactoryBinding<
  T extends AnyMeta = AnyMeta,
  Deps extends Dependencies = {},
  Phase extends MetaPhase = MetaPhase,
  Call = unknown,
  Input = unknown,
> extends Dependant<Deps>,
    MetaBindingToken<T> {
  readonly kind: MetadataKind.FACTORY
  readonly phase: Phase
  readonly resolve: (
    context: DependencyContext<Deps>,
    call: Call,
    input: Input,
  ) => MaybePromise<ResolveInjectableType<T>>
}

export type BeforeDecodeMetaBinding<
  T extends AnyMeta = AnyMeta,
  Deps extends Dependencies = {},
  Call = unknown,
> = MetaFactoryBinding<T, Deps, 'beforeDecode', Call, unknown>

export type AfterDecodeMetaBinding<
  T extends AnyMeta = AnyMeta,
  Deps extends Dependencies = {},
  Call = unknown,
  Input = unknown,
> = MetaFactoryBinding<T, Deps, 'afterDecode', Call, Input>

export type AnyFactoryMetaBinding<
  T extends AnyMeta = AnyMeta,
  Deps extends Dependencies = Dependencies,
  Phase extends MetaPhase = MetaPhase,
  Call = any,
  Input = any,
> = MetaFactoryBinding<T, Deps, Phase, Call, Input>

export type AnyMetaBinding =
  | StaticMetaBinding<AnyMeta>
  | MetaFactoryBinding<AnyMeta, Dependencies, MetaPhase, any, any>

export type MetaFactoryMethod<Value, Call = unknown> = {
  <Deps extends Dependencies = {}>(params: {
    dependencies?: Deps
    phase?: 'beforeDecode'
    resolve: (
      context: DependencyContext<Deps>,
      call: Call,
      payload: unknown,
    ) => MaybePromise<Value>
  }): BeforeDecodeMetaBinding<MetaToken<Value>, Deps, Call>
  <Deps extends Dependencies = {}, Input = unknown>(params: {
    dependencies?: Deps
    phase: 'afterDecode'
    resolve: (
      context: DependencyContext<Deps>,
      call: Call,
      input: Input,
    ) => MaybePromise<Value>
  }): AfterDecodeMetaBinding<MetaToken<Value>, Deps, Call, Input>
}

export type ResolveMetaBindingMeta<T extends AnyMetaBinding> =
  T[typeof kMetaBinding]

export const getStaticMetaValue = <T extends AnyMeta>(
  bindings: Iterable<StaticMetaBinding>,
  meta: T,
): ResolveInjectableType<T> | undefined => {
  let value: ResolveInjectableType<T> | undefined

  for (const binding of bindings) {
    if (getMetaBindingMeta(binding) === meta) {
      value = binding.value as ResolveInjectableType<T>
    }
  }

  return value
}

export function createMeta<
  Value,
  Kind extends MetadataKind = MetadataKind,
  Call = unknown,
>(): Meta<Value, Kind, Call> {
  const injectable = createLazyInjectable<Value, Scope.Call>(Scope.Call)

  const meta = {
    ...injectable,
    [kMetadata]: true as const,
    $withType: () => meta as any,
    optional: () => createOptionalInjectable(meta),
    static: (value: Value) =>
      Object.freeze({
        dependencies: {},
        kind: MetadataKind.STATIC,
        value,
        [kMetaBinding]: meta,
      }) as StaticMetaBinding<MetaToken<Value>>,
    factory: ((params: {
      dependencies?: Dependencies
      phase?: MetaPhase
      resolve: (
        context: DependencyContext<any>,
        call: Call,
        input: unknown,
      ) => unknown
    }) => {
      return Object.freeze({
        dependencies: params.dependencies ?? {},
        kind: MetadataKind.FACTORY,
        phase: params.phase ?? 'beforeDecode',
        resolve: params.resolve,
        [kMetaBinding]: meta,
      })
    }) as MetaFactoryMethod<Value, Call>,
  }

  return Object.freeze(meta) as Meta<Value, Kind, Call>
}

export const isMeta = (value: any): value is AnyMeta =>
  Boolean(value?.[kMetadata])

export const isMetaBinding = (value: any): value is AnyMetaBinding =>
  Boolean(value?.[kMetaBinding])

export const isStaticMetaBinding = (value: any): value is StaticMetaBinding =>
  isMetaBinding(value) && value.kind === MetadataKind.STATIC

export const isFactoryMetaBinding = (
  value: any,
): value is AnyFactoryMetaBinding =>
  isMetaBinding(value) && value.kind === MetadataKind.FACTORY

export const getMetaBindingMeta = <T extends AnyMetaBinding>(
  binding: T,
): ResolveMetaBindingMeta<T> => binding[kMetaBinding]

export function assertUniqueMetaBindings(
  bindings: readonly AnyMetaBinding[],
  label: string,
): void
export function assertUniqueMetaBindings<
  T extends { readonly [kMetaBinding]: AnyMeta },
>(bindings: Iterable<T>, label: string): void
export function assertUniqueMetaBindings<
  T extends { readonly [kMetaBinding]: AnyMeta },
>(bindings: Iterable<T>, label: string) {
  const seen = new Map<AnyMeta, number>()
  let index = 0

  for (const binding of bindings) {
    const meta = binding[kMetaBinding]
    const previousIndex = seen.get(meta)

    if (typeof previousIndex !== 'undefined') {
      throw new Error(
        `Duplicate meta registration in ${label}: the same meta token was registered more than once within a single scope (entries ${previousIndex + 1} and ${index + 1}). Register each meta token only once per scope.`,
      )
    }

    seen.set(meta, index)
    index++
  }
}
