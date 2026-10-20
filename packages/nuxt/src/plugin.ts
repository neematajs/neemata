import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { NeemRolldownPlugin, RolldownPluginOption } from '@nmtjs/neem'

import type { NeemNuxtRoutingKind } from './types.ts'
import { APP_DIR } from './constants.ts'
import {
  assertRoutingBase,
  importKitFrom,
  normalizeBase,
} from './nuxt-loader.ts'

const VIRTUAL_OPTIONS = 'neem-nuxt:options'
const RESOLVED_OPTIONS = '\0neem-nuxt:options'
const VIRTUAL_IMPL = 'neem-nuxt:impl'

export type NeemNuxtArtifactPluginOptions = {
  root: string
  base?: string
  routing?: NeemNuxtRoutingKind
}

type ResolvedAppInfo = {
  base: string
  assetsDir: string
}

/**
 * Rolldown plugin injected into the Nuxt runtime's worker artifact build.
 *
 * Neem compiles the same worker entry with Rolldown's DevEngine in `neem dev`
 * and `rolldown.build` in `neem build` and `neem preview`; a preview is the
 * production build with Nuxt's browser and server maps enabled. The DevEngine reports
 * `this.meta.watchMode` as false, so the mode signal is its `devMode` input
 * option (or watch mode for a plain `rolldown.watch` build). Instead of
 * shipping both code paths behind runtime flags, the plugin resolves `neem-nuxt:impl` to the dev or prod implementation, so each
 * artifact only ever contains the code it runs: the dev artifact boots Nuxt's
 * dev pipeline, the prod artifact hosts the built nitro server and never
 * imports nuxt.
 */
export function neemNuxtArtifactPlugin(
  options: NeemNuxtArtifactPluginOptions,
): RolldownPluginOption {
  // createNuxtRuntime already normalizes, but the plugin is exported on its
  // own — normalize here too so restoreBase's trailing-slash invariant holds
  // for direct consumers.
  const explicitBase = options.base ? normalizeBase(options.base) : undefined
  // Needed twice in a build (baked options + nitro build); resolve once.
  let appInfo: Promise<ResolvedAppInfo> | undefined
  const resolveAppInfo = () => {
    appInfo ??= (async () => {
      const kit = await importKitFrom(options.root)
      const config = await kit.loadNuxtConfig({ cwd: options.root })
      return {
        base: explicitBase ?? normalizeBase(config.app?.baseURL ?? '/'),
        assetsDir: config.app?.buildAssetsDir ?? '/_nuxt/',
      }
    })()
    return appInfo
  }

  let dev = false
  let preview = false
  const plugin: NeemRolldownPlugin = {
    name: 'neem-nuxt:artifact',
    configureNeemBuild(context) {
      preview = context.command === 'preview'
    },
    options(input) {
      dev = this.meta.watchMode || input.experimental?.devMode != null
    },
    resolveId(id) {
      if (id === VIRTUAL_OPTIONS) return RESOLVED_OPTIONS
      if (id === VIRTUAL_IMPL) {
        return resolveImplEntry(dev ? 'dev' : 'prod')
      }
      return null
    },
    async load(id) {
      if (id !== RESOLVED_OPTIONS) return null
      if (dev) {
        return bakedOptionsModule({
          root: options.root,
          base: explicitBase,
          routing: options.routing,
        })
      }
      const { base, assetsDir } = await resolveAppInfo()
      assertRoutingBase(options.routing, base)
      return bakedOptionsModule({ base, routing: options.routing, assetsDir })
    },
    async writeBundle(output) {
      if (dev) return
      if (!output.dir) {
        throw new Error('neem-nuxt requires a directory-based worker artifact')
      }

      const kit = await importKitFrom(options.root)
      const { base } = await resolveAppInfo()
      const appOutDir = resolve(output.dir, APP_DIR)

      // `node` (node-listener) is the embeddable nitro preset: its entry
      // exports a request listener instead of self-listening, which is what
      // the prod runtime hosts behind the worker-owned server.
      const nuxt = await kit.loadNuxt({
        cwd: options.root,
        dev: false,
        overrides: {
          telemetry: false,
          nitro: {
            preset: 'node',
            output: { dir: appOutDir },
            ...(preview ? { sourceMap: true } : {}),
          },
          ...(explicitBase ? { app: { baseURL: base } } : {}),
          ...(preview ? previewOverrides(output.dir) : {}),
        },
      })
      if (preview) nuxt.hook('vite:extendConfig', linkPreviewSourceMaps)
      try {
        await kit.buildNuxt(nuxt)
      } finally {
        await nuxt.close().catch(() => {})
      }

      // Backstop for config/module shapes that redirect output or swap the
      // preset behind the overrides: fail the build, not prod start.
      if (!existsSync(resolve(appOutDir, 'server/index.mjs'))) {
        throw new Error(
          `Nuxt build for [${options.root}] did not produce ${APP_DIR}/server/index.mjs; ` +
            'the neem-nuxt preset hosts the nitro "node" preset output and needs its server entry',
        )
      }
    },
  }
  return plugin
}

/**
 * A preview is for debugging the built app locally, so both sides get linked
 * maps: Nuxt's production default omits browser maps, and deployment configs
 * turn them off or hide them at each level Nuxt reads (`sourcemap`,
 * `nitro.sourceMap`, and Vite's `build.sourcemap`, which wins over both).
 */
function previewOverrides(artifactDir: string) {
  const viteMaps = { build: { sourcemap: true } }
  return {
    sourcemap: { server: true, client: true },
    vite: { ...viteMaps, $client: viteMaps, $server: viteMaps },
    // Generated intermediates go next to the preview artifact, so a preview
    // build does not rewrite the `.nuxt` a running `neem dev` uses.
    buildDir: resolve(artifactDir, '..', '.nuxt'),
  }
}

type ViteBuildMaps = {
  sourcemap?: unknown
  rolldownOptions?: { output?: object | object[] }
  rollupOptions?: { output?: object | object[] }
}

type ViteConfigMaps = {
  build?: ViteBuildMaps
  environments?: Record<string, { build?: ViteBuildMaps } | undefined>
}

/**
 * The config overrides cannot remove a Rolldown output-level `sourcemap`:
 * Nuxt merges them with defu, which keeps the app's nested value and
 * concatenates output arrays, and Vite spreads each output entry over its
 * defaults, so that value wins over the forced `build.sourcemap`. Nuxt calls
 * this hook with the merged client and server configs (or, under the Vite
 * environment API, with the shared config and its client/ssr environments)
 * right before building, so the setting is dropped there. An environment's
 * own `build.sourcemap` also wins over the top-level one, so each visited
 * build is forced to linked maps too. The nested objects are shared with the
 * config Vite builds from, so they are edited in place.
 */
function linkPreviewSourceMaps(config: ViteConfigMaps): void {
  const builds = [
    config.build,
    ...Object.values(config.environments ?? {}).map((env) => env?.build),
  ]
  for (const build of builds) {
    if (!build) continue
    build.sourcemap = true
    // Vite 8 aliases the legacy `rollupOptions` to `rolldownOptions`, and
    // either may be the one it reads.
    for (const options of [build.rolldownOptions, build.rollupOptions]) {
      const outputs = options?.output
      if (!outputs) continue
      for (const output of Array.isArray(outputs) ? outputs : [outputs]) {
        delete (output as { sourcemap?: unknown }).sourcemap
      }
    }
  }
}

function bakedOptionsModule(options: {
  root?: string
  base?: string
  routing?: NeemNuxtRoutingKind
  assetsDir?: string
}): string {
  return `export default ${JSON.stringify(options)}`
}

// Same source-or-dist fallback Neem uses for its internal entries: inside the
// workspace the .ts sources exist and rolldown bundles them directly; from a
// published install only the compiled .js files ship.
function resolveImplEntry(name: 'dev' | 'prod'): string {
  const source = new URL(`./neem/${name}.ts`, import.meta.url)
  if (existsSync(source)) return fileURLToPath(source)
  return fileURLToPath(new URL(`./neem/${name}.js`, import.meta.url))
}
