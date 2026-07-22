// Resolved by the neem-vite artifact plugin at bundle time (src/plugin.ts):
// `neem-vite:options` is generated from the runtime declaration options and
// `neem-vite:impl` points at the dev or prod implementation depending on
// whether the worker artifact is a watch (dev) or one-shot (build) compile.
declare module 'neem-vite:options' {
  const options: import('./types.ts').NeemViteBakedOptions
  export default options
}

declare module 'neem-vite:impl' {
  const createRuntime: import('./types.ts').NeemViteRuntimeFactory
  export default createRuntime
}
