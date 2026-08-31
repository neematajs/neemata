// Rolldown injects this source beside its DevRuntime prelude. Keeping the
// client transport-free lets Neem deliver patches over worker parent ports.
export const NEEM_HMR_IMPLEMENTATION = String.raw`
;(() => {
  class NeemHotContext {
    constructor(moduleId) {
      this.moduleId = moduleId
      this.callbacks = []
    }

    accept(callback) {
      this.callbacks.push({
        deps: [this.moduleId],
        fn: typeof callback === 'function'
          ? (modules) => callback(modules[0])
          : () => undefined,
      })
    }

    invalidate() {
      throw new Error('Neem experimental HMR does not support import.meta.hot.invalidate()')
    }
  }

  class NeemDevRuntime extends DevRuntime {
    hotContexts = new Map()

    createModuleHotContext(moduleId) {
      const context = new NeemHotContext(moduleId)
      this.hotContexts.set(moduleId, context)
      return context
    }
  }

  class NeemHmrClient {
    constructor(runtime) {
      this.runtime = runtime
      this.lastSeq = 0
    }

    isSelfAccepted(id) {
      return this.runtime.hotContexts.get(id)?.callbacks.some(
        (callback) => callback.deps.includes(id),
      ) ?? false
    }

    compute(changedIds) {
      const boundaries = []
      const updateSet = new Set()
      const traversed = new Set()
      for (const changed of changedIds) {
        if (!this.runtime.isExecuted(changed)) continue
        const rejected = this.bubble(
          changed,
          [changed],
          updateSet,
          boundaries,
          traversed,
        )
        if (rejected) return rejected
      }
      return boundaries.length
        ? { type: 'boundaries', boundaries, updateSet: [...updateSet] }
        : { type: 'noop' }
    }

    bubble(id, stack, updateSet, boundaries, traversed) {
      if (traversed.has(id)) return undefined
      traversed.add(id)
      updateSet.add(id)
      if (this.isSelfAccepted(id)) {
        boundaries.push([id, id])
        return undefined
      }

      const parents = this.runtime
        .getImporters(id)
        .filter((parent) => this.runtime.isExecuted(parent))
      if (parents.length === 0) {
        return { type: 'reload', reason: 'no HMR boundary for ' + id }
      }
      for (const parent of parents) {
        if (stack.includes(parent)) {
          return {
            type: 'reload',
            reason: 'circular HMR path between ' + id + ' and ' + parent,
          }
        }
        const rejected = this.bubble(
          parent,
          [...stack, parent],
          updateSet,
          boundaries,
          traversed,
        )
        if (rejected) return rejected
      }
      return undefined
    }

    async apply(update, url) {
      if (update.type === 'Noop') return { accepted: true, delivered: false }
      if (update.type === 'FullReload') {
        return {
          accepted: false,
          delivered: false,
          reason: update.reason ?? 'Rolldown requested a full reload',
        }
      }
      if (update.seq !== this.lastSeq + 1) {
        return {
          accepted: false,
          delivered: false,
          reason:
            'HMR sequence gap: expected ' +
            (this.lastSeq + 1) +
            ', received ' +
            update.seq,
        }
      }
      this.lastSeq = update.seq

      const computed = this.compute(update.changedIds)
      if (computed.type === 'noop') {
        return { accepted: true, delivered: false }
      }
      if (computed.type === 'reload') {
        return { accepted: false, delivered: false, reason: computed.reason }
      }

      try {
        await import(url)
      } catch (error) {
        return {
          accepted: false,
          delivered: false,
          reason: 'failed to import HMR patch: ' + String(error),
        }
      }

      for (const id of computed.updateSet) {
        if (!this.runtime.hasFactory(id)) {
          return {
            accepted: false,
            delivered: true,
            reason: 'HMR patch has no factory for ' + id,
          }
        }
      }

      const applies = computed.boundaries.map(([boundary, acceptedVia]) => ({
        acceptedVia,
        callbacks: this.runtime.hotContexts.get(boundary)?.callbacks ?? [],
      }))
      try {
        for (const id of computed.updateSet) this.runtime.removeModuleCache(id)
        for (const { acceptedVia, callbacks } of applies) {
          this.runtime.initModule(acceptedVia)
          const fresh = this.runtime.loadExports(acceptedVia)
          for (const callback of callbacks) await callback.fn([fresh])
        }
      } catch (error) {
        return {
          accepted: false,
          delivered: true,
          reason: 'failed to apply HMR patch: ' + String(error),
        }
      }
      return { accepted: true, delivered: true }
    }
  }

  const clientId = globalThis.__neem_hmr_client_id__ ?? crypto.randomUUID()
  const runtime = globalThis.__rolldown_runtime__ ??=
    new NeemDevRuntime(clientId)
  const client = new NeemHmrClient(runtime)
  runtime.hooks = {
    createModuleHotContext: (id) => runtime.createModuleHotContext(id),
    onModuleCacheRemoval: (id) => runtime.hotContexts.delete(id),
  }
  globalThis.__neem_hmr__ = {
    clientId,
    apply: (update, url) => client.apply(update, url),
  }
})()
`
