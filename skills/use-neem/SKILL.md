---
name: use-neem
description: 'Use when configuring or running @nmtjs/neem projects: neem.config.ts, runtime discovery, package runtime helpers, CLI build/dev/start lifecycle, artifacts, plugins, metrics, env, proxy, health, and runtime selection.'
---

# Use Neem

`@nmtjs/neem` is the framework-agnostic runtime orchestration layer. Neem
discovers runtime declarations, builds artifacts, writes manifests, starts
selected runtimes, reloads changed runtime graphs, wires env/logger/plugin
hooks, exposes health, and routes proxy traffic to runtime upstreams.
Neem itself has no Effect dependency. Host an Effect application with
`@nmtjs/effect`; the application owns its transports and services.

Use this skill when consuming Neem in an application or service repo:
`neem.config.ts`, `neem build`, `neem dev`, `neem start`, runtime selection,
proxying, env, plugins, metrics, and package-owned runtime helpers.

For authoring custom runtime helpers, raw `defineRuntime(...)`, runtime hosts,
runtime workers, runtime planners, or host/worker `MessagePort` protocols, use
`build-neem-runtime`.

## References

- [Runtimes](references/runtimes.md) - `defineConfig`, runtime discovery,
  declarations, config shape, env precedence, proxy, health, logger, plugins.
- [CLI](references/cli.md) - `neem build`, `neem dev`, `neem start`,
  `dev --env-files`, Node/Bun, runtime selection, output, reload, shutdown.
- [Metrics](references/metrics.md) - metrics plugin, `/metrics` server,
  default metrics injection, Pushgateway, and lifecycle/health observations.
- [Package Integration](references/package-integration.md) - package-owned
  runtime helpers, workflows planner/worker contracts, Promise versus Effect
  resources, and Redis client ownership.
- [Effect Applications](references/effect.md) - `createEffectRuntime`,
  `defineEffectWorker`, Layer requirements, readiness, and supervised shutdown.
