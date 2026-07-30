import type {
  NeemRuntime,
  NeemRuntimeProxyConfig,
  NeemRuntimeWorkerContext,
} from '@nmtjs/neem'

export type NeemViteRoutingKind = 'path' | 'subdomain' | 'default'

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
 * Options baked into the worker artifact via the `neem-vite:options` virtual
 * module. The plugin emits mode-specific values: the dev artifact gets the
 * app root (it loads the app config itself), the prod artifact only gets the
 * resolved base — baking the build machine's absolute root into production
 * would cost artifact-hash stability and leak local paths for no use.
 */
export type NeemViteBakedOptions = {
  root?: string
  base?: string
  routing?: NeemViteRoutingKind
}

export type NeemViteWorkerContext = NeemRuntimeWorkerContext<
  unknown,
  NeemViteBakedOptions
>

/**
 * Shape shared by the dev and prod implementations behind the
 * `neem-vite:impl` virtual module, so the worker entry stays mode-agnostic.
 */
export type NeemViteRuntimeFactory = (
  ctx: NeemViteWorkerContext,
  options: NeemViteBakedOptions,
) => NeemRuntime
