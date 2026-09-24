/**
 * Types for patch-client.js. Rolldown's DevEngine prelude declares the
 * `DevRuntime` class the client extends; these are the members it relies on.
 */
export type DevRuntimeBase = {
  // Static importers of each module, including modules that have not run.
  importers: Map<string, Set<string>>
  hooks: DevRuntimeHooks | null
  isExecuted: (id: string) => boolean
  // Static importers of a module, whether or not they have run.
  getImporters: (id: string) => string[]
  hasFactory: (id: string) => boolean
  removeModuleCache: (id: string) => void
  initModule: (id: string) => unknown
  loadExports: (id: string) => unknown
}

export type DevRuntimeConstructor = new (clientId: string) => DevRuntimeBase

export type DevRuntimeHooks = {
  createModuleHotContext: (moduleId: string) => unknown
  onModuleCacheRemoval: (moduleId: string) => void
}

// `import.meta.hot.data`: survives module instances, as in Vite.
export type HotData = Record<string, unknown>

export type HotAcceptCallback = {
  deps: string[]
  fn: (modules: unknown[]) => unknown
}

export type HotDisposer = (data: HotData) => unknown
