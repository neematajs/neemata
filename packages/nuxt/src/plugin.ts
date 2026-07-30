import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { RolldownPluginOption } from '@nmtjs/neem'
import type { Plugin as RolldownPlugin } from 'rolldown'

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
 * Neem compiles the same worker entry with `rolldown.watch` in dev and
 * `rolldown.build` in `neem build`, so `this.meta.watchMode` is the mode
 * signal. Instead of shipping both code paths behind runtime flags, the
 * plugin resolves `neem-nuxt:impl` to the dev or prod implementation, so each
 * artifact only ever contains the code it runs: the dev artifact boots Nuxt's
 * dev pipeline, the prod artifact hosts the built nitro server and never
 * imports nuxt.
 */
export function neemNuxtArtifactPlugin(
  options: NeemNuxtArtifactPluginOptions,
): RolldownPluginOption {
  // Needed twice in a build (baked options + nitro build); resolve once.
  let appInfo: Promise<ResolvedAppInfo> | undefined
  const resolveAppInfo = () => {
    appInfo ??= (async () => {
      const kit = await importKitFrom(options.root)
      const config = await kit.loadNuxtConfig({ cwd: options.root })
      return {
        base: options.base ?? normalizeBase(config.app?.baseURL ?? '/'),
        assetsDir: config.app?.buildAssetsDir ?? '/_nuxt/',
      }
    })()
    return appInfo
  }

  const plugin: RolldownPlugin = {
    name: 'neem-nuxt:artifact',
    resolveId(id) {
      if (id === VIRTUAL_OPTIONS) return RESOLVED_OPTIONS
      if (id === VIRTUAL_IMPL) {
        return resolveImplEntry(this.meta.watchMode ? 'dev' : 'prod')
      }
      return null
    },
    async load(id) {
      if (id !== RESOLVED_OPTIONS) return null
      if (this.meta.watchMode) {
        return bakedOptionsModule({
          root: options.root,
          base: options.base,
          routing: options.routing,
        })
      }
      const { base, assetsDir } = await resolveAppInfo()
      assertRoutingBase(options.routing, base)
      return bakedOptionsModule({ base, routing: options.routing, assetsDir })
    },
    async writeBundle(output) {
      if (this.meta.watchMode) return
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
          nitro: { preset: 'node', output: { dir: appOutDir } },
          ...(options.base ? { app: { baseURL: base } } : {}),
        },
      })
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
