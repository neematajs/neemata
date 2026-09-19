/** Subdirectory of the worker artifact outDir that receives the Vite build. */
export const APP_DIR = 'app'

/**
 * `server.hmr` keys that pin the browser HMR client's endpoint. Any of them
 * would make it connect past the Neem proxy, so the config sanitizer drops
 * them and the resolved-config tripwire refuses them.
 */
export const HMR_ENDPOINT_KEYS = [
  'host',
  'port',
  'clientPort',
  'server',
  'protocol',
] as const
