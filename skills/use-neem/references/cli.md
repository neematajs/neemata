# CLI

Neem's ESM CLI builds, watches, and starts named runtimes. The package exports
`@nmtjs/neem` and `@nmtjs/neem/cli`; it has no separate CommonJS entry. The
installed `neem` executable has a Node shebang. Bun is also exercised by the
Neem e2e suite; to choose Bun explicitly, run the CLI script with Bun:

```bash
bun node_modules/@nmtjs/neem/bin/neem.js dev
```

## Commands and Defaults

```bash
neem build [runtime[,runtime...]] --config neem.config.ts --outDir dist
neem dev [runtime[,runtime...]] --config neem.config.ts --outDir .neem
neem start [runtime[,runtime...]] --outDir dist
```

- Build/dev default `--config` to `neem.config.ts`.
- Build output precedence: `--outDir`, config `outDir`, then `dist`.
- Dev defaults to `.neem`; start defaults to `dist`. Neither uses config
  `outDir` as a fallback. Start has no config option.
- Config and output CLI paths resolve from the working directory; config
  `outDir` also resolves from cwd. Runtime paths resolve from the config file.
- Dev enables Node's compile cache when the API is available. Use `--no-cache`
  to disable it or `--cacheDir` to choose its directory.

## Runtime Selection

Selection is a comma-separated positional argument, for example
`neem build api,worker` or `neem start api`. Names are trimmed, empty names are
ignored, and duplicates removed. Omitted/empty selection includes all runtimes;
unknown names fail. Names are declaration names, not paths/globs.

Build/dev resolve and validate declarations before filtering the build graph.
Build selection determines manifest contents. Start filters the built manifest;
it cannot start runtimes omitted from that build and does not read source config.

## Build and Output

Build imports config with cache busting, resolves declarations, compiles runtime
worker/host/planner, plugin and logger artifacts, writes `neem.manifest.json`,
and generates start wrappers. A typical output is:

```text
dist/neem.manifest.json
dist/start.js
dist/runtimes/<runtime-directory>/start.js
dist/runtime/start.js
dist/runtime/worker-entry.js
dist/runtime/runner-entry.js
dist/runtime/<sanitized-name>/{worker,host,planner}/...
dist/config/plugins/...
dist/config/logger/...
```

Worker, plugin, and logger directories exist only when configured. Artifact
filenames come from the manifest; do not guess them. Per-runtime wrapper
folder names preserve simple alphanumeric/underscore/hyphen names; other names
are encoded. A package name such as `@app/api` is not a literal wrapper path.

Build/dev clean Neem-owned `runtime`, `runtimes`, `config`, manifest, and start
files in the output directory. The output cannot equal or contain the config
directory. Deploy the output together, including shared infrastructure/chunks
and any external dependencies needed by the artifacts.

## Dev Reload

Dev uses a watcher service worker for config/builds and a runtime service
worker for the controller. Each runtime has a host-runner thread and its
planned application worker threads.

- Initial watcher readiness starts the runtime service.
- Config or selected runtime declaration changes restart watcher and runtime.
- Worker, planner, or runtime host artifact changes reload that runtime.
- Plugin or logger artifact changes restart the runtime service.
- Rebuild errors are reported without automatically exiting. An invalid config
  edit stops the runtime; fixing the watched config/declaration restarts it.
- A failed runtime reload leaves that runtime stopped and readiness unavailable;
  dev remains available for a subsequent edit to recover it.
- Initial startup failures, service worker failures, and fatal runtime service
  errors close the command. A worker failure after readiness first goes through
  runtime recovery (see below).

### Environment Files

```bash
neem dev --env-files ../../.env
neem dev --env-files .env.local,../../.env
```

- Use plural `--env-files`; Node/pnpm can consume singular `--env-file` before
  Neem sees it. Pass one comma-separated value, not repeated flags.
- Paths are relative to cwd even with `--config` elsewhere. Paths are trimmed;
  empty paths, missing files, and decryption errors fail startup.
- Dotenvx loads into `process.env` before config evaluation and service creation.
  Existing process values win, then the first file defining a variable.
  Variable expansion and encrypted values are supported.
- Loading is opt-in and runs once. Restart dev after editing env files;
  config/runtime reloads do not reload them. Build/start have no such option.
- Bun loads its own env files before Neem, so those values are existing process
  values and win over explicit files. Bun loads `.env.local` in development
  and skips it with `NODE_ENV=test`; explicitly listing it still loads it via
  Dotenvx, without overriding values already loaded from `.env` or the shell.

`NeemConfig.env` is an inline string map, not a file list. See
[runtime env precedence](runtimes.md#environment).

## Start, Failure, and Shutdown

`neem start` loads the built manifest via a runtime service. Generated wrappers
start the controller directly; per-runtime wrappers select one runtime:

```bash
node dist/start.js
node dist/runtimes/api/start.js
```

Manifest settings/artifacts remain the source of truth, with the documented
[network env overrides](runtimes.md#proxy-and-health) and
[metrics env overrides](metrics.md#deploy-time-overrides) resolved at start.

- A worker start failure rejects initial boot, cleans up already-started
  workers, and exits the command unsuccessfully. Server readiness is not
  published. Each worker has 30,000 ms to become ready during startup.
- After readiness, a host/worker failure restarts the whole affected runtime,
  including its sibling workers. CLI dev allows one recovery attempt;
  production allows three with a one-second delay. Exhaustion is fatal.
  Successful recovery updates proxy upstreams and restores readiness.
- `SIGINT`/`SIGTERM` request shutdown in dev, start, and standalone wrappers.
  Stop reaches workers while startup is pending, including an asynchronous
  factory. Once a factory resolves, Neem calls the runtime's stop once even
  if start never ran, and suppresses late readiness.
- Workers have a hard 5,000 ms stop deadline shared by unfinished factory work
  and finalizers; after it Neem terminates the thread. The deadline is not a
  `NeemConfig` option. Workflow `cleanupTimeoutMs` cannot extend it.
- Runtime `finished` completion/rejection before a requested stop is a failure.
  After stop is requested it does not trigger recovery. Resource cleanup must
  be cooperative and bounded; shutdown does not promise finalizers past the
  thread deadline.

Health and readiness are separate; see [probes](runtimes.md#proxy-and-health).
