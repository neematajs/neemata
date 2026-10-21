import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  NeemBuildContext,
  NeemRolldownPlugin,
  RolldownPluginOption,
} from '@nmtjs/neem'
import type * as Vite from 'vite'

import type { NeemViteRoutingKind } from './types.ts'
import type { LoadedAppViteConfig } from './vite-loader.ts'
import { APP_DIR } from './constants.ts'
import {
  assertRoutingBase,
  importViteFrom,
  loadAppViteConfig,
} from './vite-loader.ts'

const VIRTUAL_OPTIONS = 'neem-vite:options'
const RESOLVED_OPTIONS = '\0neem-vite:options'
const VIRTUAL_IMPL = 'neem-vite:impl'

export type NeemViteArtifactPluginOptions = {
  root: string
  base?: string
  routing?: NeemViteRoutingKind
}

/**
 * Rolldown plugin injected into the Vite runtime's worker artifact build.
 *
 * Neem compiles the same worker entry with Rolldown's DevEngine in `neem dev`
 * and `rolldown.build` in `neem build` and `neem preview`; a preview is the
 * production build with browser maps on unless the app sets them. The DevEngine reports
 * `this.meta.watchMode` as false, so the mode signal is its `devMode` input
 * option (or watch mode for a plain `rolldown.watch` build). Instead of
 * shipping both code paths behind runtime flags, the plugin resolves `neem-vite:impl` to the dev or prod implementation, so each
 * artifact only ever contains the code it runs: the dev artifact boots Vite's
 * dev server, the prod artifact serves the built app and never imports vite.
 */
export function neemViteArtifactPlugin(
  options: NeemViteArtifactPluginOptions,
): RolldownPluginOption {
  // The app config is needed twice in a build (baked options + vite build);
  // load it once per compile.
  let buildConfig: Promise<LoadedAppViteConfig> | undefined
  const loadBuildConfig = () => {
    buildConfig ??= importViteFrom(options.root).then((vite) =>
      loadAppViteConfig(vite, {
        root: options.root,
        base: options.base,
        command: 'build',
      }),
    )
    return buildConfig
  }

  let dev = false
  let sourcemap: NeemBuildContext['sourcemap']
  const plugin: NeemRolldownPlugin = {
    name: 'neem-vite:artifact',
    configureNeemBuild(context) {
      sourcemap = context.sourcemap
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
          base: options.base,
          routing: options.routing,
        })
      }
      const { base } = await loadBuildConfig()
      assertRoutingBase(options.routing, base)
      return bakedOptionsModule({ base, routing: options.routing })
    },
    async writeBundle(output) {
      if (dev) return
      if (!output.dir) {
        throw new Error('neem-vite requires a directory-based worker artifact')
      }

      const vite = await importViteFrom(options.root)
      const loaded = await loadBuildConfig()
      for (const warning of loaded.warnings) this.warn(warning)

      const appOutDir = resolve(output.dir, APP_DIR)
      const config = withDefaultSourceMaps(loaded.config, sourcemap)
      await vite.build({
        ...config,
        build: {
          ...config.build,
          // The app is an opaque asset closure next to the worker bundle;
          // rolldown must not re-emit or re-hash it, so vite writes directly
          // into the artifact outDir instead of going through emitFile.
          outDir: appOutDir,
          emptyOutDir: true,
        },
      })

      // Backstop for config/plugin shapes the sanitizer cannot see (a plugin
      // config hook may still redirect output): fail the build, not prod start.
      if (!existsSync(resolve(appOutDir, 'index.html'))) {
        throw new Error(
          `Vite build for [${options.root}] did not produce ${APP_DIR}/index.html; ` +
            'the neem-vite preset serves static SPA/MPA output and needs an html entry',
        )
      }
    },
  }
  return plugin
}

/**
 * Neem's map setting for the command (see `NeemBuildContext.sourcemap`)
 * applies only where the app sets none: an app `build.sourcemap` wins, and
 * Vite's own precedence lets a client environment's `build.sourcemap` or a
 * Rolldown output-level `sourcemap` win over it too.
 */
function withDefaultSourceMaps(
  config: Vite.InlineConfig,
  sourcemap: NeemBuildContext['sourcemap'],
): Vite.InlineConfig {
  if (sourcemap === undefined || config.build?.sourcemap !== undefined) {
    return config
  }
  return { ...config, build: { ...config.build, sourcemap } }
}

function bakedOptionsModule(options: {
  root?: string
  base?: string
  routing?: NeemViteRoutingKind
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
