---
name: build-neem-runtime
description: 'Use when authoring custom @nmtjs/neem runtimes or package runtime helpers: defineRuntime, createRuntime, defineRuntimeHost, defineRuntimeWorker, defineRuntimePlanner, host/worker ports, planner output, lifecycle, and runtime entry validation.'
---

# Build Neem Runtime

Use this skill when building runtime implementations for Neem: reusable package
helpers, custom runtime declaration helpers, runtime hosts, runtime workers,
runtime planners, lifecycle contracts, and host/worker message protocols.

Import the public authoring API and types from `@nmtjs/neem`. Neem uses Pino
loggers and has no runtime dependency on Effect. Package presets own application resources and protocols.

App/service repos should usually use `use-neem` to consume package helpers;
use this skill when implementing those helpers or a custom runtime.

## Essential contracts

- Declarations reference entry specifiers; planner, host, and worker modules
  default-export values made by the corresponding `defineRuntime*` helper.
- Planner and host execute in one host-runner thread per runtime. Each planned
  worker executes in its own thread. Keep resource creation in its owner.
- Workers must become ready before the host factory runs. Do not make worker
  startup wait for a message from that host.
- Worker `start()` returns optional proxy upstreams, not cleanup callbacks.
  Worker `stop()` must handle partial startup within a hard 5,000 ms deadline.
- Use `finished` to report long-lived worker work ending. A failure before
  readiness rejects startup; it does not enter ready-worker recovery.

## References

- [Declarations](references/declarations.md) - raw `defineRuntime(...)`,
  reusable `createRuntime(...)` helpers, declaration layering, entry resolution.
- [Entries](references/entries.md) - `defineRuntimeWorker`,
  `defineRuntimePlanner`, `defineRuntimeHost`, lifecycle results, failure
  origins, ports, and `definePluginHooks`.
- [Package Helpers](references/package-helpers.md) - the Workflows and Effect
  presets as examples of declaration defaults, planners, and resource ownership.
