# UnJS Package Review For Neem

Source reviewed: https://github.com/unjs/website/tree/main/content/packages

This document lists UnJS packages that may be useful for the new `@nmtjs/neem`
implementation. It is an adoption map, not an implementation plan.

## Best Candidates

| Package | Fit for Neem | Usefulness | Direction |
| --- | --- | --- | --- |
| `perfect-debounce` | `neem dev` reload scheduler | High | Consider for timer/control mechanics, not request semantics |
| `pathe` | Manifest/outDir/relative paths | High | Strong candidate for manifest-facing path code |
| `defu` | Build option inheritance/merging | High | Strong candidate after merge semantics are specified |
| `ohash` | Stable config/artifact fingerprints | High | Useful for reload planning and snapshot comparison |
| `pkg-types` | Package/workspace/tsconfig discovery | Medium-high | Useful for CLI/project-root polish |
| `c12` | Config loading ideas | Medium, risky | Study/borrow ideas; do not replace Neem config pipeline yet |
| `hookable` | Lifecycle/plugin extension hooks | Medium-high | Already installed; use more intentionally |
| `httpxy` | HTTP/WebSocket proxy fallback | Medium | Compare later against `@nmtjs/proxy` requirements |
| `get-port-please` / `listhen` | Dev ports/listeners | Medium | Useful when proxy/dev UX matures |
| `ufo` | URL normalization/routing helpers | Medium | Useful if proxy URL routing grows |
| `unstorage` | Host/plugin store capability | Medium | Good candidate for future store abstraction |
| `unplugin` | Build adapter/plugin ecosystem | Medium | Useful for Rolldown/Vite/Rollup-compatible plugin packages |
| `mlly` | ESM/import utilities | Low-medium | Useful only if current import utils grow |
| `confbox` | YAML/TOML/JSONC parsing | Low-medium | Useful only if non-TS config formats are added |
| `consola` | CLI logging | Low | Skip; Neem uses common logger |
| `destr` | Safer JSON parsing | Low | Skip for manifest; internal shape is intentionally trusted |
| `untyped` | Config docs/types generation | Low now | Defer |

## Package Notes

### `perfect-debounce`

Maps to the current latest-wins reload problem in `neem dev`. It supports
async debounced functions plus cancellation/flush controls.

Use it only for low-level debounce mechanics. Neem still needs its own scheduler
state:

- full reload wins over app reloads
- plugin changes upgrade to full reload
- app reloads coalesce per app name
- failed runtime apply must not lose newer pending work
- stop must cancel pending work

Current scheduler works. Switching to `perfect-debounce` is only worth it if it
removes code without hiding these rules.

### `pathe`

Strong fit for manifest-facing paths. Neem writes relative paths into
`neem.manifest.json`; those should remain slash-normalized and portable.

Likely targets:

- `toManifestPath`
- manifest artifact `file`/`outDir`
- build output path normalization
- static discovery path reporting

Keep Node `path` for native filesystem/worker APIs where native separators are
expected.

### `defu`

Good fit for merging inherited Rolldown build options:

- config/app/plugin build defaults
- entry artifact config
- plugin-declared child artifact config
- user overrides

Risk: Rolldown option arrays are semantic. `plugins`, `external`, `output`,
`input`, and resolver options may require different merge behavior. Do not use
plain recursive merge blindly.

Recommended shape:

- create `mergeRolldownOptions()`
- implement with `createDefu` or a small wrapper around `defu`
- add focused tests for arrays and nested output fields

### `ohash`

Useful for reload planning:

- hash app config slices
- hash plugin config/options slices
- hash artifact declarations
- compare runtime snapshots cheaply
- log why a reload was full/scoped

Use for stable fingerprints, not security.

### `pkg-types`

Useful for CLI polish and project boundary detection:

- find nearest package/root
- read package metadata
- read tsconfig
- improve default config lookup later

Not urgent, but likely useful once `neem build/start/dev` need better
workspace/package behavior.

### `c12`

Tempting but risky as direct replacement.

Pros:

- TS/JS/JSON/YAML/TOML config loading
- `.env`
- `extends`
- package config
- config watching
- import/resolve hooks

Conflict with Neem:

- Neem must statically discover lazy import thunks before execution.
- Neem compiles a hashed config artifact so runtime imports can see fresh config
  paths.
- Loading/executing config through a generic config loader can reintroduce cache
  and eager-import problems.

Use as design reference for config resolution and `extends` later. Do not
replace current config artifact pipeline now.

### `hookable`

Already dependency. Useful if Neem wants a first-class internal hook bus rather
than ad hoc callbacks.

Possible future hooks:

- `build:before`
- `build:artifact`
- `build:manifest`
- `runtime:start`
- `runtime:ready`
- `runtime:stop`
- `dev:rebuild`
- `dev:reload`
- `dev:error`
- `app:start`
- `app:stop`
- `plugin:setup`
- `plugin:stop`
- `proxy:start`
- `proxy:stop`

Need decide which hook failures are fatal.

### `httpxy`

Could be a pure Node proxy implementation/fallback. It supports HTTP and
WebSocket proxying, forwarded headers, keep-alive agent behavior, rewriting, and
timeouts.

Do not swap now. Compare later against `@nmtjs/proxy` requirements:

- TLS/SNI
- sticky sessions
- health checks
- upstream add/remove lifecycle
- WebSocket behavior
- native performance goals

### `listhen` And `get-port-please`

Useful once Neem owns more dev-facing listeners:

- proxy port selection
- graceful signal handling
- URL display
- optional HTTPS dev support

Not core until proxy/dev admin surfaces are clearer.

### `unstorage`

Good future candidate for store-as-capability:

- async key-value API
- driver ecosystem
- mounted namespaces
- watches/snapshots

Potential consumers:

- jobs plugin
- subscriptions
- dev/runtime metadata
- plugin state

Do not add until Neem store contract is designed.

### `unplugin`

Useful for consumer/plugin ecosystems around source transforms. For example,
Vue/React/email/PDF-oriented plugins can publish one plugin factory that works
across Rolldown/Rollup/Vite/Webpack/esbuild.

Neem itself should keep Rolldown as primary compiler. Adapter packages can use
`unplugin` to expose portable transforms.

### `mlly`

Potentially useful for ESM import/resolution edge cases, default export
interop, and package/module utilities. Current `importDefault` helper is still
small, so keep this deferred.

### `confbox`

Useful only if Neem adds limited non-TS config formats. Rich Neem config with
lazy import thunks still needs TypeScript/JavaScript.

### `ufo` And `radix3`

Useful if proxy routing grows:

- URL normalization and joining (`ufo`)
- route/host/path matching (`radix3`)

Defer until proxy design expands.

## Skip For Neem Core

- `nitro`: too high-level; competes with Neem host model.
- `unbuild` / `mkdist`: package build tooling, not app/runtime build pipeline.
- `jiti`: avoid for current path. Node 24 + Rolldown artifacts are preferred;
  runtime TS loading would revive cache invalidation issues.
- `destr`: not needed for internal manifest parsing under current assumptions.
- `consola`: conflicts with common logger direction.
- `fs-memo`, `rc9`, `giget`, `nypm`, `changelogen`, `automd`, `ungh`,
  `fontaine`, `ipx`, `image-meta`: no strong current Neem runtime fit.

## Suggested Adoption Order

1. Add `pathe` for manifest-facing path normalization.
2. Add `defu` only with explicit `mergeRolldownOptions()` tests.
3. Consider `perfect-debounce` for dev scheduler cleanup if code gets simpler.
4. Add `ohash` for scoped reload planning and artifact/config fingerprints.
5. Keep `c12` as design reference for future config resolution/extends.
6. Compare `httpxy` only during proxy hardening.

