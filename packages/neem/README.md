# Neem

## Development environment files

Load an environment file before evaluating `neem.config.ts` and starting workers:

```sh
neem dev --env-files ../../.env
```

For multiple files, use a comma-separated list:

```sh
neem dev --env-files .env.local,../../.env
```

Paths are relative to the working directory, including when using `--config`.
Existing process environment variables take precedence, followed by the first
file defining a variable. Files are loaded using
[@dotenvx/dotenvx](https://dotenvx.com/docs/sdk/config), which supports variable
expansion and encrypted values. Missing files or decryption errors fail startup.

Files are loaded once; restart `neem dev` after changing them. Without
`--env-files`, Neem does not load environment files automatically. This option is
only available on `dev`; `build` and `start` use their existing environment.

`NeemConfig.env` remains an inline environment map included in the manifest.
