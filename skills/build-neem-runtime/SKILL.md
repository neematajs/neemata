---
name: build-neem-runtime
description: "Use when authoring custom @nmtjs/neem runtimes or package runtime helpers: defineRuntime, createRuntime, defineRuntimeHost, defineRuntimeWorker, defineRuntimePlanner, host/worker ports, planner output, lifecycle, and runtime entry validation."
---

# Build Neem Runtime

Use this skill when building runtime implementations for Neem: reusable package
helpers, custom runtime declaration helpers, runtime hosts, runtime workers,
runtime planners, lifecycle contracts, and host/worker message protocols.

Neem runtime authoring is separate from project consumption. App/service repos
should usually use `use-neem` and consume package helpers; runtime packages use
this skill to define those helpers.

## References

- [Declarations](references/declarations.md) - raw `defineRuntime(...)`,
  reusable `createRuntime(...)` helpers, declaration layering, entry resolution.
- [Entries](references/entries.md) - `defineRuntimeWorker`,
  `defineRuntimePlanner`, `defineRuntimeHost`, lifecycle, planner data, ports.
- [Package Helpers](references/package-helpers.md) - how package helpers wrap
  raw Neem primitives and expose narrow end-user APIs.
