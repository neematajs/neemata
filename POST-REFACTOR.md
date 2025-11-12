# Neemata Post-Refactor Backlog

These items are intentionally deferred until the runtime refactor lands. Revisit once the core architecture stabilizes.

## Dependency & Build Adjustments
- [ ] Review `package.json` files for application/runtime/gateway to remove circular deps and align with new responsibilities.
- [ ] Update build scripts, entry points, and Vite config to reference the new runtime bootstrap.
- [ ] Remove legacy CLI or compatibility layers no longer required.

## Documentation & Examples
- [ ] Refresh `README.md` (root and relevant packages) to outline the new architecture, runtime orchestrator usage, and single gateway workflow.
- [ ] Update examples/playgrounds to use the new config and bootstrap patterns.
- [ ] Provide migration notes for framework consumers (even without legacy support, highlight new APIs).

## Observability & Policies
- [ ] Prototype unified metrics exporters for server/runtime/application layers (likely Prometheus endpoints).
- [ ] Design gateway-level rate limiting / throttling hooks that can integrate with transports and runtime policies.
