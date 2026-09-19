import type { NeemViteRoutingKind } from './types.ts'

// Vite also accepts relative ('', './') and full-URL bases, but neither can
// describe an app hosted behind the Neem proxy — reject instead of silently
// mangling them into broken absolute paths.
export function normalizeBase(base: string): string {
  if (base === '/') return '/'
  if (base === '' || base === './' || !base.startsWith('/')) {
    throw new Error(
      `neem-vite supports absolute path bases only (e.g. "/app/"); received [${base}]`,
    )
  }
  return base.endsWith('/') ? base : `${base}/`
}

export function assertRoutingBase(
  routing: NeemViteRoutingKind | undefined,
  base: string,
): void {
  if (routing === 'path' && base === '/') {
    throw new Error(
      'Path-routed Neem proxy strips the "/<route>/" prefix upstream, so the Vite app must be built ' +
        'with a matching base: set base to the proxy route (e.g. "/web/") or use default/subdomain routing',
    )
  }
}

/**
 * A path-routed Neem proxy strips the `/<route>/` prefix before forwarding,
 * while Vite (configured with that prefix as `base`) expects it — restore it
 * for proxied requests. Direct (unproxied) requests that already carry the
 * base pass through untouched.
 */
export function restoreBase(req: { url?: string }, base: string): void {
  const prefix = base.slice(0, -1)
  const url = req.url ?? '/'
  if (url !== prefix && !url.startsWith(base)) {
    req.url = prefix + url
  }
}
