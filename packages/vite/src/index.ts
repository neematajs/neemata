import type { NeemMarkedRuntimeDeclaration } from '@nmtjs/neem'
import { defineRuntime } from '@nmtjs/neem'

import type { NeemViteRuntimeOptions } from './types.ts'
import { neemViteArtifactPlugin } from './plugin.ts'
import { normalizeBase } from './vite-loader.ts'

export type {
  NeemViteBakedOptions,
  NeemViteRoutingKind,
  NeemViteRuntimeFactory,
  NeemViteRuntimeOptions,
  NeemViteWorkerContext,
} from './types.ts'
export { APP_DIR } from './constants.ts'
export {
  type NeemViteArtifactPluginOptions,
  neemViteArtifactPlugin,
} from './plugin.ts'

/**
 * Declares a Neem runtime that hosts a Vite app: the dev artifact runs Vite's
 * dev server (HMR included), the prod artifact serves the `vite build` output
 * that `neem build` places next to the worker bundle.
 */
export function createViteRuntime(
  options: NeemViteRuntimeOptions,
): NeemMarkedRuntimeDeclaration {
  const routing = options.proxy
    ? (options.proxy.routing?.type ?? 'path')
    : undefined
  const base = options.base ? normalizeBase(options.base) : undefined
  // Fail at declaration load, not first request: path routing without an
  // explicit matching base yields an app whose asset URLs miss the route.
  // The app's vite-config base cannot be read here (declaration loading is
  // synchronous), so path routing demands the base up front.
  if (routing === 'path' && (!base || base === '/')) {
    throw new Error(
      'Vite runtime behind a path-routed proxy requires an explicit non-root [base] matching the ' +
        'proxy route (e.g. "/web/"); alternatively use proxy routing type "default" or "subdomain"',
    )
  }

  return defineRuntime({
    ...(options.name ? { name: options.name } : {}),
    ...(options.proxy ? { proxy: options.proxy } : {}),
    planner: '@nmtjs/vite/neem/planner',
    worker: {
      entry: '@nmtjs/vite/neem/worker',
      build: {
        rolldown: {
          // vite is resolved from the app root at runtime (see vite-loader);
          // keeping it external makes any accidental static import fail
          // loudly instead of silently bundling a bundler into the artifact.
          external: ['vite'],
          plugins: [
            neemViteArtifactPlugin({ root: options.root, base, routing }),
          ],
        },
      },
    },
  })
}
