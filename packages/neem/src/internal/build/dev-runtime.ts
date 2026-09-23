// Rolldown injects this source beside its DevRuntime prelude. Keeping the
// client transport-free lets Neem deliver patches over worker parent ports.
export const NEEM_DEV_RUNTIME = String.raw`
;(() => {
  class NeemHotContext {
    constructor(moduleId, data) {
      this.moduleId = moduleId
      this.callbacks = []
      this.disposers = []
      this.data = data
    }

    dispose(callback) {
      this.disposers.push(callback)
    }

    prune() {}
    on() {}
    off() {}
    send() {}

    accept(callback) {
      if (Array.isArray(callback) || typeof callback === 'string') {
        throw new Error('Neem patching supports only self-accept; dependency accepts are not supported')
      }
      this.callbacks.push({
        deps: [this.moduleId],
        fn: typeof callback === 'function'
          ? (modules) => callback(modules[0])
          : () => undefined,
      })
    }

    invalidate() {
      throw new Error('Neem patching does not support import.meta.hot.invalidate()')
    }
  }

  class NeemDevRuntime extends DevRuntime {
    hotContexts = new Map()
    // import.meta.hot.data outlives module instances, as in Vite.
    hotData = new Map()

    createModuleHotContext(moduleId) {
      let data = this.hotData.get(moduleId)
      if (!data) this.hotData.set(moduleId, (data = {}))
      const context = new NeemHotContext(moduleId, data)
      this.hotContexts.set(moduleId, context)
      return context
    }
  }

  class NeemPatchClient {
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
        // Checked after the patch registers its graph; see unreachedModules.
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
        return { type: 'reload', reason: 'no patch boundary for ' + id }
      }
      for (const parent of parents) {
        if (stack.includes(parent)) {
          return {
            type: 'reload',
            reason: 'circular patch path between ' + id + ' and ' + parent,
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

    // A changed module that has not run yet executes during this update only
    // when a re-executed module imports it statically (a newly added module).
    // Otherwise it loads later from its chunk on disk, whose scope-hoisted code
    // predates the update and ignores patched factories.
    unreachedModules(changedIds, updateSet) {
      const pending = changedIds.filter((id) => !this.runtime.isExecuted(id))
      const reached = new Set(updateSet)
      let grew = true
      while (grew) {
        grew = false
        for (const id of pending) {
          if (reached.has(id)) continue
          const importers = this.runtime.importers.get(id) ?? []
          if ([...importers].some((importer) => reached.has(importer))) {
            reached.add(id)
            grew = true
          }
        }
      }
      return pending.filter((id) => !reached.has(id))
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
            'Patch sequence gap: expected ' +
            (this.lastSeq + 1) +
            ', received ' +
            update.seq,
        }
      }
      this.lastSeq = update.seq

      const computed = this.compute(update.changedIds)
      if (computed.type === 'reload') {
        return { accepted: false, delivered: false, reason: computed.reason }
      }
      if (computed.type === 'noop') {
        if (!update.changedIds.length) return { accepted: true, delivered: false }
        return {
          accepted: false,
          delivered: false,
          reason: 'update changes modules that have not run yet: ' +
            update.changedIds.join(', '),
        }
      }

      try {
        await import(url)
      } catch (error) {
        return {
          accepted: false,
          delivered: false,
          reason: 'failed to import patch: ' + String(error),
        }
      }

      for (const id of computed.updateSet) {
        if (!this.runtime.hasFactory(id)) {
          return {
            accepted: false,
            delivered: true,
            reason: 'patch has no factory for ' + id,
          }
        }
      }
      const unreached = this.unreachedModules(
        update.changedIds,
        computed.updateSet,
      )
      if (unreached.length) {
        return {
          accepted: false,
          delivered: true,
          reason: 'update changes modules that have not run yet: ' +
            unreached.join(', '),
        }
      }

      const applies = computed.boundaries.map(([boundary, acceptedVia]) => ({
        acceptedVia,
        callbacks: this.runtime.hotContexts.get(boundary)?.callbacks ?? [],
      }))
      try {
        // Release resources of the instances being replaced before their
        // successors execute, handing state over through hot.data.
        for (const id of computed.updateSet) {
          const context = this.runtime.hotContexts.get(id)
          for (const dispose of context?.disposers ?? [])
            await dispose(context.data)
        }
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
          reason: 'failed to apply patch: ' + String(error),
        }
      }
      return { accepted: true, delivered: true }
    }
  }

  const clientId = globalThis.__neem_patch_client_id__ ?? crypto.randomUUID()
  const runtime = globalThis.__rolldown_runtime__ ??=
    new NeemDevRuntime(clientId)
  const client = new NeemPatchClient(runtime)
  runtime.hooks = {
    createModuleHotContext: (id) => runtime.createModuleHotContext(id),
    onModuleCacheRemoval: (id) => runtime.hotContexts.delete(id),
  }
  globalThis.__neem_patches__ = {
    clientId,
    apply: (update, url) => client.apply(update, url),
  }
})()
`
