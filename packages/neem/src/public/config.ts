import type {
  NeemConfig,
  NeemMarkedRuntimeDeclaration,
  NeemPluginInput,
  NeemRuntimeBuildConfig,
  NeemRuntimeDeclaration,
  NeemRuntimeDeclarationLayer,
  NeemRuntimeHostDeclaration,
  NeemRuntimeProjectEntries,
  NeemRuntimeWorkerDeclaration,
} from '../shared/types.ts'
import { mergeUserRolldownOptions } from '../shared/rolldown.ts'
import { NeemRuntimeDeclarationBrand } from './runtime.ts'

export function defineConfig<const TRuntimes extends NeemRuntimeProjectEntries>(
  config: NeemConfig<TRuntimes>,
): NeemConfig<TRuntimes> {
  return Object.freeze(config)
}

export function definePlugin<const T extends NeemPluginInput>(plugin: T): T {
  return Object.freeze(plugin)
}

export function defineRuntime<
  const TDeclaration extends NeemRuntimeDeclaration,
>(declaration: TDeclaration): NeemMarkedRuntimeDeclaration<TDeclaration> {
  return Object.freeze({
    ...declaration,
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
    ...commonRest
  } = commonOptions
  const { worker: _userWorker, host: _userHost, ...userRest } = userOptions

  return {
    ...commonRest,
    ...userRest,
    ...(worker ? { worker } : {}),
    ...(host ? { host } : {}),
  }
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
    commonBuild?.rolldown,
    userBuild?.rolldown,
  )
  if (!commonBuild && !userBuild && !rolldown) return undefined
  return { ...commonBuild, ...userBuild, ...(rolldown ? { rolldown } : {}) }
}
