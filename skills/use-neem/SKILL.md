---
name: use-neem
description: Use when configuring or running @nmtjs/neem projects: neem.config.ts, runtime discovery, package runtime helpers, CLI build/dev/start lifecycle, artifacts, plugins, env, proxy, health, and runtime selection.
---

# Use Neem

`@nmtjs/neem` is the framework-agnostic runtime orchestration layer. Neem
discovers runtime declarations, builds artifacts, writes manifests, starts
selected runtimes, reloads changed runtime graphs, wires env/logger/plugin
hooks, exposes health, and routes proxy traffic to runtime upstreams.

Use this skill when consuming Neem in an application or service repo:
`neem.config.ts`, `neem build`, `neem dev`, `neem start`, runtime selection,
proxying, env, plugins, and package-owned runtime helpers.

For authoring custom runtime helpers, raw `defineRuntime(...)`, runtime hosts,
runtime workers, runtime planners, or host/worker `MessagePort` protocols, use
`build-neem-runtime`.

## References

- [Runtimes](references/runtimes.md) - `defineConfig`, runtime discovery,
  package runtime declaration files, config shape, env, proxy, plugins.
- [CLI](references/cli.md) - `neem build`, `neem dev`, `neem start`,
  runtime selection, output layout, dev reload behavior.
- [Package Integration](references/package-integration.md) - package-owned
  runtime helpers and generic runtime project layout for end users.
