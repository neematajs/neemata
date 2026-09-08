# CLI

Neem CLI owns build, dev, and production start orchestration. Commands use
runtime names for selection; runtime discovery still comes from
`neem.config.ts`.

## Commands

```bash
neem build [runtime[,runtime...]] --config neem.config.ts --outDir dist
neem dev [runtime[,runtime...]] --config neem.config.ts --outDir .neem
neem start [runtime[,runtime...]] --outDir dist
```

Defaults:

- `build --config`: `neem.config.ts`.
- `build --outDir`: config `outDir`, then `dist`.
- `dev --config`: `neem.config.ts`.
- `dev --outDir`: `.neem`.
- `start --outDir`: `dist`.

## Runtime Selection

Runtime selection is a comma-separated positional argument:

```bash
neem build api,worker
neem dev api
neem start api,worker
```

Rules:

- Empty names are ignored and duplicates are removed.
- Selection uses runtime names, not paths or globs.
- Unknown selected names fail.
- If omitted, all resolved runtimes are included.
- Build selection filters the build graph before manifest creation.
- Start selection filters the built manifest; production `start` does not read
  source config.

## Build

`neem build`:

- imports config with cache busting;
- resolves runtime declaration files from `runtimes`;
- builds selected runtime, worker, host, planner, plugin, and logger artifacts;
- writes `neem.manifest.json`;
- writes start entrypoints.

Expected output shape:

```text
dist/neem.manifest.json
dist/start.js
dist/runtimes/<runtime>/start.js
dist/runtime/start.js
dist/runtime/worker-entry.js
runtime worker/host/planner artifacts
plugin/logger artifacts
```

## Dev

`neem dev` starts two service workers:

- watcher service: watches config, runtime declarations, and build graph;
- runtime service: starts runtime host/worker processes from current manifest.

Reload behavior:

- initial watcher ready event starts the runtime service;
- config invalidation restarts watcher and runtime;
- runtime or runtime-host changes reload that runtime;
- plugin or logger changes restart the runtime service;
- watcher/runtime errors close the dev command.

`SIGINT` and `SIGTERM` stop watcher and runtime services.

### Environment Files

Use `--env-files` for development projects that need a local or monorepo-root
environment file:

```bash
neem dev --env-files ../../.env
neem dev --env-files .env.local,../../.env
```

- The option is plural: Node.js can consume `--env-file` before Neem or pnpm
  handles it.
- Pass multiple files as one comma-separated value, not repeated flags.
- Paths resolve from the working directory, even when `--config` points elsewhere.
- Dotenvx loads files into `process.env` before config evaluation and service
  worker creation. Runtime workers inherit the values.
- Existing process variables win, then the first file defining a variable.
  Dotenvx supports variable expansion and encrypted values.
- Empty paths, missing files, or decryption errors fail startup.
- Loading is opt-in and happens once. Restart `neem dev` after editing env files;
  ordinary config/runtime reloads do not reload them.
- `build` and `start` do not support this option; provide their environment
  externally.

`NeemConfig.env` remains an inline string map baked into the manifest. Do not
put file paths there or add an `envFiles` config property; env-file loading is
a dev CLI option.

## Start

`neem start` starts the built runtime server from `dist/neem.manifest.json`.
Use built per-runtime entrypoints when deployment should boot one runtime:

```bash
node dist/start.js
node dist/runtimes/api/start.js
```

Production start preserves manifest as source of truth: selected runtimes,
artifacts, env, proxy config, logger config, and plugins come from built output.
