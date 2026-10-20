import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { NeemRolldownPlugin, RolldownPluginOption } from '@nmtjs/neem'
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
 * production build with the app's browser maps enabled. The DevEngine reports
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
  let preview = false
  const plugin: NeemRolldownPlugin = {
    name: 'neem-vite:artifact',
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
      const config = preview
        ? withPreviewSourceMaps(loaded.config)
        : loaded.config
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
 * A preview is for debugging the built app locally: linked browser maps even
 * when the app config turns them off or hides them. `build.sourcemap` alone is
 * not enough, because the client environment's build options take precedence
 * over it and Vite spreads each Rolldown output entry over its own defaults,
 * so an output-level `sourcemap` wins too. Only the config the app wrote is
 * covered; plugins that set maps later in Vite's config hooks are not.
 */
function withPreviewSourceMaps(config: Vite.InlineConfig): Vite.InlineConfig {
  const previewConfig = { ...config, build: withLinkedSourceMaps(config.build) }
  const client = config.environments?.client
  if (client?.build) {
    previewConfig.environments = {
      ...config.environments,
      client: { ...client, build: withLinkedSourceMaps(client.build) },
    }
  }
  return previewConfig
}

function withLinkedSourceMaps(
  build: Vite.BuildEnvironmentOptions = {},
): Vite.BuildEnvironmentOptions {
  // Vite 8 aliases the legacy `rollupOptions` to `rolldownOptions`, and
  // either may be the one it reads, so both are cleared of output maps.
  const { rolldownOptions, rollupOptions } = build
  return {
    ...build,
    sourcemap: true,
    ...(rolldownOptions && {
      rolldownOptions: withoutOutputSourceMaps(rolldownOptions),
    }),
    ...(rollupOptions && {
      rollupOptions: withoutOutputSourceMaps(rollupOptions),
    }),
  }
}

// Dropping the output-level setting (rather than forcing it to true) lets the
// forced `build.sourcemap` apply and avoids Vite's unsupported-option warning.
function withoutOutputSourceMaps<
  T extends NonNullable<Vite.BuildEnvironmentOptions['rolldownOptions']>,
>(options: T): T {
  const { output } = options
  if (!output) return options
  const strip = ({
    sourcemap: _sourcemap,
    ...rest
  }: Vite.Rolldown.OutputOptions) => rest
  return {
    ...options,
    output: Array.isArray(output) ? output.map(strip) : strip(output),
  }
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
