import type {
  NeemRuntime,
  NeemRuntimeProxyConfig,
  NeemRuntimeWorkerContext,
} from '@nmtjs/neem'

export type NeemNuxtRoutingKind = 'path' | 'subdomain' | 'default'

export type NeemNuxtRuntimeOptions = {
  /** Absolute path to the Nuxt app root (the directory with nuxt.config). */
  root: string
  /**
   * Public base path, applied as Nuxt `app.baseURL`. When omitted, the app's
   * own config value (or '/') is used. Required (non-'/') for path-routed
   * proxies, since the proxy strips the route prefix upstream.
   */
  base?: string
  /** Runtime name. Defaults to the nearest package.json name. */
  name?: string
  proxy?: NeemRuntimeProxyConfig
}

/**
 * Options baked into the worker artifact via the `neem-nuxt:options` virtual
 * module. The plugin emits mode-specific values: the dev artifact gets the
 * app root (it loads the app itself), the prod artifact only gets the
 * resolved base and assets dir — baking the build machine's absolute root
 * into production would cost artifact-hash stability and leak local paths
 * for no use.
 */
export type NeemNuxtBakedOptions = {
  root?: string
  base?: string
  routing?: NeemNuxtRoutingKind
  /** Resolved `app.buildAssetsDir` — the immutable-cache asset prefix. */
  assetsDir?: string
}

export type NeemNuxtWorkerContext = NeemRuntimeWorkerContext<
  unknown,
  NeemNuxtBakedOptions
>

/**
 * Shape shared by the dev and prod implementations behind the
 * `neem-nuxt:impl` virtual module, so the worker entry stays mode-agnostic.
 */
export type NeemNuxtRuntimeFactory = (
  ctx: NeemNuxtWorkerContext,
  options: NeemNuxtBakedOptions,
) => NeemRuntime
