import type {
  NeemConfig,
  NeemEntryInput,
  NeemMarkedRuntimeDeclaration,
  NeemPluginInput,
  NeemRuntimeBuildConfig,
  NeemRuntimeDeclaration,
  NeemRuntimeDeclarationLayer,
  NeemRuntimeProxyConfig,
} from '../shared/types.ts'
import { mergeUserRolldownOptions } from '../shared/rolldown.ts'
import { NeemRuntimeDeclarationBrand } from './runtime.ts'

export function defineConfig(config: NeemConfig): NeemConfig {
  return Object.freeze({
    ...config,
    ...(config.env ? { env: freezeRuntimeEnv(config.env) } : {}),
  })
}

export function definePlugin<const T extends NeemPluginInput>(plugin: T): T {
  return Object.freeze({ ...plugin })
}

export function defineRuntime<
  const TDeclaration extends NeemRuntimeDeclaration,
>(declaration: TDeclaration): NeemMarkedRuntimeDeclaration<TDeclaration> {
  return Object.freeze({
    ...declaration,
    ...(declaration.env ? { env: freezeRuntimeEnv(declaration.env) } : {}),
    [NeemRuntimeDeclarationBrand]: true,
  }) as NeemMarkedRuntimeDeclaration<TDeclaration>
}

export function createRuntime<
  const TCommon extends NeemRuntimeDeclarationLayer,
>(commonOptions: TCommon) {
  return function defineRuntimeProject<
    const TUser extends NeemRuntimeDeclarationLayer,
  >(userOptions: TUser): NeemMarkedRuntimeDeclaration {
    return defineRuntime(
      mergeRuntimeDeclarationLayers(commonOptions, userOptions),
    )
  }
}

export function isNeemRuntimeDeclaration(
  value: any,
): value is NeemMarkedRuntimeDeclaration {
  return (
    typeof value === 'object' &&
    value !== null &&
    value[NeemRuntimeDeclarationBrand] === true
  )
}

function mergeRuntimeDeclarationLayers(
  commonOptions: NeemRuntimeDeclarationLayer,
  userOptions: NeemRuntimeDeclarationLayer,
): NeemRuntimeDeclaration {
  return {
    ...commonOptions,
    ...userOptions,
    env: mergeRuntimeEnv(commonOptions.env, userOptions.env),
    proxy: mergeRuntimeProxyConfig(commonOptions.proxy, userOptions.proxy),
    worker: mergeEntryDeclaration(commonOptions.worker, userOptions.worker),
    host: mergeEntryDeclaration(commonOptions.host, userOptions.host),
  } as NeemRuntimeDeclaration
}

function mergeRuntimeEnv(
  commonEnv: NeemRuntimeDeclarationLayer['env'],
  userEnv: NeemRuntimeDeclarationLayer['env'],
): NeemRuntimeDeclaration['env'] | undefined {
  if (!commonEnv && !userEnv) return undefined
  return freezeRuntimeEnv({ ...commonEnv, ...userEnv })
}

function freezeRuntimeEnv<const T extends NeemRuntimeDeclaration['env']>(
  env: T,
): T {
  return Object.freeze({ ...env }) as T
}

function mergeRuntimeProxyConfig(
  commonProxy: NeemRuntimeDeclarationLayer['proxy'],
  userProxy: NeemRuntimeDeclarationLayer['proxy'],
): NeemRuntimeProxyConfig | undefined {
  if (!commonProxy && !userProxy) return undefined
  // Routing is a mode selection, not a bag of options: the user layer replaces
  // it wholesale instead of deep-merging into the common layer's mode.
  return {
    ...commonProxy,
    ...userProxy,
    routing: userProxy?.routing ?? commonProxy?.routing,
  }
}

// Worker and host declarations share the same {entry, build} merge shape.
function mergeEntryDeclaration<
  T extends { entry?: NeemEntryInput; build?: NeemRuntimeBuildConfig },
>(common: Partial<T> | undefined, user: Partial<T> | undefined): T | undefined {
  if (!common && !user) return undefined
  return {
    ...common,
    ...user,
    build: mergeRuntimeBuildConfig(common?.build, user?.build),
  } as T
}

function mergeRuntimeBuildConfig(
  commonBuild: NeemRuntimeBuildConfig | undefined,
  userBuild: NeemRuntimeBuildConfig | undefined,
): NeemRuntimeBuildConfig | undefined {
  // mergeUserRolldownOptions gives user options scalar priority while its
  // plugin merger keeps common-layer (framework preset) plugins running
  // before user plugins — pinned by config.spec.
  const rolldown = mergeUserRolldownOptions(
    userBuild?.rolldown,
    commonBuild?.rolldown,
  )
  const chunks = userBuild?.chunks ?? commonBuild?.chunks
  if (Object.keys(rolldown).length === 0 && chunks === undefined) {
    return undefined
  }
  return {
    ...(Object.keys(rolldown).length > 0 ? { rolldown } : {}),
    ...(chunks !== undefined ? { chunks } : {}),
  }
}
