// Resolved by the neem-nuxt artifact plugin at bundle time (src/plugin.ts):
// `neem-nuxt:options` is generated from the runtime declaration options and
// `neem-nuxt:impl` points at the dev or prod implementation depending on
// whether the worker artifact is a watch (dev) or one-shot (build) compile.
declare module 'neem-nuxt:options' {
  const options: import('./types.ts').NeemNuxtBakedOptions
  export default options
}

declare module 'neem-nuxt:impl' {
  const createRuntime: import('./types.ts').NeemNuxtRuntimeFactory
  export default createRuntime
}
