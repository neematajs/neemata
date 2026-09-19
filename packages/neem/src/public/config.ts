import type {
  NeemConfig,
  NeemEntryInput,
  NeemEnv,
  NeemMarkedRuntimeDeclaration,
  NeemPluginInput,
  NeemRuntimeBuildConfig,
  NeemRuntimeDeclaration,
  NeemRuntimeDeclarationLayer,
  NeemRuntimeProxyConfig,
} from '../shared/types.ts'
import { mergeUserRolldownOptions } from '../shared/rolldown.ts'
import { NeemRuntimeDeclarationBrand } from './runtime.ts'

// Worker and host declarations share the same {entry, build} merge shape.
type EntryDeclaration = {
  entry?: NeemEntryInput
  build?: NeemRuntimeBuildConfig
}

export function defineConfig(config: NeemConfig): NeemConfig {
  return Object.freeze({
    ...config,
    ...(config.env ? { env: Object.freeze({ ...config.env }) } : {}),
  })
}

export function definePlugin<const T extends NeemPluginInput>(plugin: T): T {
  return Object.freeze({ ...plugin })
}

export function defineRuntime<const T extends NeemRuntimeDeclaration>(
  declaration: T,
): NeemMarkedRuntimeDeclaration<T> {
  return Object.freeze({
    ...declaration,
    ...(declaration.env ? { env: Object.freeze({ ...declaration.env }) } : {}),
    [NeemRuntimeDeclarationBrand]: true,
  }) as NeemMarkedRuntimeDeclaration<T>
}

export function createRuntime(common: NeemRuntimeDeclarationLayer) {
  return (user: NeemRuntimeDeclarationLayer): NeemMarkedRuntimeDeclaration =>
    defineRuntime(mergeRuntimeDeclarationLayers(common, user))
}

export function isNeemRuntimeDeclaration(
  value: unknown,
): value is NeemMarkedRuntimeDeclaration {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[NeemRuntimeDeclarationBrand] === true
  )
}

function mergeRuntimeDeclarationLayers(
  common: NeemRuntimeDeclarationLayer,
  user: NeemRuntimeDeclarationLayer,
): NeemRuntimeDeclaration {
  // Merged layers can still leave a worker without an entry; the build rejects
  // that in validateRuntimeDeclaration, where the offending file is known.
  return {
    ...common,
    ...user,
    env: mergeRuntimeEnv(common.env, user.env),
    proxy: mergeRuntimeProxyConfig(common.proxy, user.proxy),
    worker: mergeEntryDeclaration(common.worker, user.worker),
    host: mergeEntryDeclaration(common.host, user.host),
  } as NeemRuntimeDeclaration
}

function mergeRuntimeEnv(
  commonEnv: NeemEnv | undefined,
  userEnv: NeemEnv | undefined,
): NeemEnv | undefined {
  if (!commonEnv && !userEnv) return undefined
  return Object.freeze({ ...commonEnv, ...userEnv })
}

function mergeRuntimeProxyConfig(
  commonProxy: NeemRuntimeProxyConfig | undefined,
  userProxy: NeemRuntimeProxyConfig | undefined,
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

function mergeEntryDeclaration(
  common: EntryDeclaration | undefined,
  user: EntryDeclaration | undefined,
): EntryDeclaration | undefined {
  if (!common && !user) return undefined
  return {
    ...common,
    ...user,
    build: mergeRuntimeBuildConfig(common?.build, user?.build),
  }
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
