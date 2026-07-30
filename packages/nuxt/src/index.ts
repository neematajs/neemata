import type { NeemMarkedRuntimeDeclaration } from '@nmtjs/neem'
import { defineRuntime } from '@nmtjs/neem'

import type { NeemNuxtRuntimeOptions } from './types.ts'
import { neemNuxtArtifactPlugin } from './plugin.ts'
import { normalizeBase } from './nuxt-loader.ts'

export type {
  NeemNuxtBakedOptions,
  NeemNuxtRoutingKind,
  NeemNuxtRuntimeFactory,
  NeemNuxtRuntimeOptions,
  NeemNuxtWorkerContext,
} from './types.ts'
export { APP_DIR } from './constants.ts'
export {
  type NeemNuxtArtifactPluginOptions,
  neemNuxtArtifactPlugin,
} from './plugin.ts'

/**
 * Declares a Neem runtime that hosts a Nuxt app: the dev artifact boots
 * Nuxt's dev pipeline in-worker (Vite HMR included) behind a worker-owned
 * listener, the prod artifact hosts the nitro `node`-preset server that
 * `neem build` places next to the worker bundle.
 */
export function createNuxtRuntime(
  options: NeemNuxtRuntimeOptions,
): NeemMarkedRuntimeDeclaration {
  const routing = options.proxy
    ? (options.proxy.routing?.type ?? 'path')
    : undefined
  const base = options.base ? normalizeBase(options.base) : undefined
  // Fail at declaration load, not first request: path routing without an
  // explicit matching base yields an app whose asset URLs miss the route.
  // The app's nuxt config cannot be read here (declaration loading is
  // synchronous), so path routing demands the base up front.
  if (routing === 'path' && (!base || base === '/')) {
    throw new Error(
      'Nuxt runtime behind a path-routed proxy requires an explicit non-root [base] matching the ' +
        'proxy route (e.g. "/admin/"), applied as app.baseURL; alternatively use proxy routing ' +
        'type "default" or "subdomain"',
    )
  }

  return defineRuntime({
    ...(options.name ? { name: options.name } : {}),
    ...(options.proxy ? { proxy: options.proxy } : {}),
    planner: '@nmtjs/nuxt/neem/planner',
    worker: {
      entry: '@nmtjs/nuxt/neem/worker',
      build: {
        rolldown: {
          // The framework is resolved from the app root at runtime (see
          // nuxt-loader); keeping these external makes any accidental static
          // import fail loudly instead of bundling nuxt into the artifact.
          external: [
            'nuxt',
            '@nuxt/kit',
            'vite',
            'h3',
            'nitropack',
            '@nuxt/nitro-server',
          ],
          plugins: [
            neemNuxtArtifactPlugin({ root: options.root, base, routing }),
          ],
        },
      },
    },
  })
}
