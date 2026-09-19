import type {
  NeemProxyRoutingOptions,
  NeemRuntime,
  NeemRuntimeProxyConfig,
  NeemRuntimeWorkerContext,
} from '@nmtjs/neem'

export type NeemViteRoutingKind = NeemProxyRoutingOptions['type']

export type NeemViteRuntimeOptions = {
  /** Absolute path to the Vite app root (the directory with index.html). */
  root: string
  /**
   * Public base path, mirrors Vite `base`. When omitted, the app's own vite
   * config base (or '/') is used. Required (non-'/') for path-routed proxies,
   * since the proxy strips the route prefix upstream.
   */
  base?: string
  /** Runtime name. Defaults to the nearest package.json name. */
  name?: string
  proxy?: NeemRuntimeProxyConfig
}

/**
 * Dev-artifact options: the dev implementation loads the app config itself,
 * so it needs the app root and leaves base resolution to the loader.
 */
export type NeemViteDevOptions = {
  mode: 'dev'
  root: string
  base?: string
  routing?: NeemViteRoutingKind
}

/**
 * Prod-artifact options: the base is resolved at build time — baking the
 * build machine's absolute root into production would cost artifact-hash
 * stability and leak local paths for no use.
 */
export type NeemViteProdOptions = {
  mode: 'prod'
  base: string
  routing?: NeemViteRoutingKind
}

/**
 * Options baked into the worker artifact via the `neem-vite:options` virtual
 * module. The plugin emits the variant that matches the implementation it
 * resolved behind `neem-vite:impl`.
 */
export type NeemViteBakedOptions = NeemViteDevOptions | NeemViteProdOptions

export type NeemViteWorkerContext = NeemRuntimeWorkerContext<
  unknown,
  NeemViteBakedOptions
>

/**
 * Shape shared by the dev and prod implementations behind the
 * `neem-vite:impl` virtual module, so the worker entry stays mode-agnostic.
 */
export type NeemViteRuntimeFactory<
  T extends NeemViteBakedOptions = NeemViteBakedOptions,
> = (ctx: NeemViteWorkerContext, options: T) => NeemRuntime
