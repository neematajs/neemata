import type { NeemNuxtRoutingKind } from './types.ts'

// Nuxt also accepts relative and full-URL baseURLs, but neither can describe
// an app hosted behind the Neem proxy — reject instead of silently mangling
// them into broken absolute paths.
export function normalizeBase(base: string): string {
  if (base === '/') return '/'
  if (base === '' || base === './' || !base.startsWith('/')) {
    throw new Error(
      `neem-nuxt supports absolute path bases only (e.g. "/admin/"); received [${base}]`,
    )
  }
  return base.endsWith('/') ? base : `${base}/`
}

export function assertRoutingBase(
  routing: NeemNuxtRoutingKind | undefined,
  base: string,
): void {
  if (routing === 'path' && base === '/') {
    throw new Error(
      'Path-routed Neem proxy strips the "/<route>/" prefix upstream, so the Nuxt app must be ' +
        'configured with a matching app.baseURL: set [base] to the proxy route (e.g. "/admin/") ' +
        'or use default/subdomain routing',
    )
  }
}

/**
 * A path-routed Neem proxy strips the `/<route>/` prefix before forwarding,
 * while Nuxt (with that prefix as app.baseURL) expects it present — nitro's
 * router and Vite's dev middleware both mount under the base. Restore it for
 * proxied requests; direct requests that already carry the base pass through.
 */
export function restoreBase(req: { url?: string }, base: string): void {
  const prefix = base.slice(0, -1)
  const url = req.url ?? '/'
  if (url !== prefix && !url.startsWith(base)) {
    req.url = prefix + url
  }
}
