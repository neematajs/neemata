# Neemata Proxy

This package lives in the Neemata workspace. Its source was imported from
`neematajs/neemata-proxy` at `87c2f1860e50145033aedc253639de18735fa82c`
(Pingora 0.9.0).

From the workspace root, run `pnpm --filter @nmtjs/proxy build:debug` for a local
debug binding or `pnpm --filter @nmtjs/proxy build` for a release binding. The
rest of the workspace uses the published package, not this build. `pnpm test:proxy`
runs Rust tests, builds the binding, checks TypeScript usage, and runs integration
tests. Generated bindings live in `dist`; platform package manifests live in
`npm`. Binaries and Cargo build output are not committed.

## What is this?

Neemata Proxy is a Rust reverse proxy exposed via N-API. It sits alongside [Neemata](https://github.com/neematajs/neemata) runtime workers, accepts incoming traffic, and routes requests to the right worker based on routing rules.

It is built on top of [Pingora](https://github.com/cloudflare/pingora) for its proxying and load-balancing core, while keeping a small JavaScript-facing surface for integration into the [Neemata](https://github.com/neematajs/neemata) runtime.

The Node.js integration is implemented with [napi-rs](https://github.com/napi-rs/napi-rs), which builds [Pingora](https://github.com/cloudflare/pingora) the native addon layer used by the runtime.

## Why does it exist?

The proxy separates request routing and transport work from application logic so that [Neemata](https://github.com/neematajs/neemata) servers can stay focused on RPC handling. This makes the runtime simpler and keeps the networking concerns in a dedicated component that can evolve independently.

It also provides a single place to manage upstreams and routing for multiple runtime workers, which keeps orchestration consistent across transports.

## Routing

Each application declares exactly one routing strategy:

```ts
type ProxyApplicationRouting =
  | { type: 'path'; name?: string }
  | { type: 'subdomain'; name?: string }
  | { type: 'default' }
```

- `type: 'path'` routes by the first path segment, then strips that segment before proxying upstream.
- `type: 'subdomain'` routes by host/subdomain.
- `type: 'default'` is the catch-all app used when no subdomain or path route matches.

Only one application may use `type: 'default'`.

Migration: replace old default routing objects:

```ts
{ routing: { default: true } }
```

with:

```ts
{
  routing: {
    type: 'default'
  }
}
```

## Related projects

- Neemata framework: https://github.com/neematajs/neemata
- Pingora: https://github.com/cloudflare/pingora
- N-API bindings: https://github.com/napi-rs/napi-rs

## Operational notes

- After `start()`, `proxy.address()` returns the bound listener address as `{ hostname, port }`. This includes the OS-assigned port when `listen` uses port `0`; it returns `null` when the proxy is not running.
- Dynamic upstream changes are eventually consistent with health checks. After `addUpstream()` or `start()`, a backend does not become routable until its health-check loop marks it healthy, so callers should expect a short convergence window where requests may still receive `503`.
- The convergence window is controlled by `healthCheckIntervalMs`. Tests in this repository use polling helpers for that reason, and production callers should follow the same pattern when they need to wait for a backend to become ready.
