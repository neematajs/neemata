import type {
  NeemConfig,
  NeemMarkedRuntimeDeclaration,
  NeemPluginInput,
  NeemRuntimeBuildConfig,
  NeemRuntimeDeclaration,
  NeemRuntimeDeclarationLayer,
  NeemRuntimeHostDeclaration,
  NeemRuntimeProjectEntries,
  NeemProxyRoutingOptions,
  NeemRuntimeProxyConfig,
  NeemRuntimeWorkerDeclaration,
} from '../shared/types.ts'
import { mergeUserRolldownOptions } from '../shared/rolldown.ts'
import { NeemRuntimeDeclarationBrand } from './runtime.ts'

export function defineConfig<const TRuntimes extends NeemRuntimeProjectEntries>(
  config: NeemConfig<TRuntimes>,
): NeemConfig<TRuntimes> {
  return Object.freeze({
    ...config,
    ...(config.env ? { env: freezeRuntimeEnv(config.env) } : {}),
  })
}

export function definePlugin<const T extends NeemPluginInput>(plugin: T): T {
  return Object.freeze(plugin)
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
  const worker = mergeRuntimeWorkerDeclarations(
    commonOptions.worker,
    userOptions.worker,
  )
  const host = mergeRuntimeHostDeclarations(
    commonOptions.host,
    userOptions.host,
  )
  const {
    worker: _commonWorker,
    host: _commonHost,
    env: commonEnv,
    proxy: commonProxy,
    ...commonRest
  } = commonOptions
  const {
    worker: _userWorker,
    host: _userHost,
    env: userEnv,
    proxy: userProxy,
    ...userRest
  } = userOptions
  const env = mergeRuntimeEnv(commonEnv, userEnv)
  const proxy = mergeRuntimeProxyConfig(commonProxy, userProxy)

  return {
    ...commonRest,
    ...userRest,
    ...(env ? { env } : {}),
    ...(proxy ? { proxy } : {}),
    ...(worker ? { worker } : {}),
    ...(host ? { host } : {}),
  }
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
  const routing = mergeRuntimeProxyRouting(
    commonProxy?.routing,
    userProxy?.routing,
  )
  return { ...commonProxy, ...userProxy, ...(routing ? { routing } : {}) }
}

function mergeRuntimeProxyRouting(
  commonRouting: NeemRuntimeProxyConfig['routing'],
  userRouting: NeemRuntimeProxyConfig['routing'],
): NeemProxyRoutingOptions | undefined {
  return userRouting ?? commonRouting
}

function mergeRuntimeWorkerDeclarations(
  commonWorker: NeemRuntimeDeclarationLayer['worker'],
  userWorker: NeemRuntimeDeclarationLayer['worker'],
): NeemRuntimeWorkerDeclaration | undefined {
  if (!commonWorker && !userWorker) return undefined
  return {
    ...commonWorker,
    ...userWorker,
    build: mergeRuntimeBuildConfig(commonWorker?.build, userWorker?.build),
  } as NeemRuntimeWorkerDeclaration
}

function mergeRuntimeHostDeclarations(
  commonHost: NeemRuntimeDeclarationLayer['host'],
  userHost: NeemRuntimeDeclarationLayer['host'],
): NeemRuntimeHostDeclaration | undefined {
  if (!commonHost && !userHost) return undefined
  return {
    ...commonHost,
    ...userHost,
    build: mergeRuntimeBuildConfig(commonHost?.build, userHost?.build),
  }
}

function mergeRuntimeBuildConfig(
  commonBuild: NeemRuntimeBuildConfig | undefined,
  userBuild: NeemRuntimeBuildConfig | undefined,
): NeemRuntimeBuildConfig | undefined {
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
