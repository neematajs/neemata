import type { IncomingMessage, ServerResponse } from 'node:http'

import type {
  NeemProxyRoutingOptions,
  NeemRuntime,
  NeemRuntimeProxyConfig,
  NeemRuntimeWorkerContext,
} from '@nmtjs/neem'

export type NeemNuxtRoutingKind = NeemProxyRoutingOptions['type']

export type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void

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
 * Dev-artifact options: the dev implementation loads the app itself, so it
 * needs the app root and reads the effective base off the loaded instance.
 */
export type NeemNuxtDevOptions = {
  mode: 'dev'
  root: string
  base?: string
  routing?: NeemNuxtRoutingKind
}

/**
 * Prod-artifact options: base and assets dir are resolved at build time —
 * baking the build machine's absolute root into production would cost
 * artifact-hash stability and leak local paths for no use.
 */
export type NeemNuxtProdOptions = {
  mode: 'prod'
  base: string
  routing?: NeemNuxtRoutingKind
  /** Resolved `app.buildAssetsDir` — the immutable-cache asset prefix. */
  assetsDir: string
}

/**
 * Options baked into the worker artifact via the `neem-nuxt:options` virtual
 * module. The plugin emits the variant that matches the implementation it
 * resolved behind `neem-nuxt:impl`.
 */
export type NeemNuxtBakedOptions = NeemNuxtDevOptions | NeemNuxtProdOptions

export type NeemNuxtWorkerContext = NeemRuntimeWorkerContext<
  unknown,
  NeemNuxtBakedOptions
>

/**
 * Shape shared by the dev and prod implementations behind the
 * `neem-nuxt:impl` virtual module, so the worker entry stays mode-agnostic.
 */
export type NeemNuxtRuntimeFactory<
  T extends NeemNuxtBakedOptions = NeemNuxtBakedOptions,
> = (ctx: NeemNuxtWorkerContext, options: T) => NeemRuntime
