// @ts-check
// The DevEngine patch client for worker threads. Rolldown injects this file as
// text beside its DevRuntime prelude (src/internal/build/dev-runtime.ts), so it
// is a script: no imports, and nothing escapes the IIFE except the globals in
// src/internal/worker/patch-globals.ts. It ships verbatim outside src because
// tsc would rewrite it as a module. Keeping it transport-free lets Neem
// deliver patches over worker parent ports.
/**
 * @import { DevRuntimeConstructor, HotAcceptCallback, HotData, HotDisposer } from './patch-client-types.js'
 * @import { WorkerUpdate } from '../src/internal/build/updates.ts'
 * @import { GenerationIntactMark, PatchGlobal } from '../src/internal/worker/patch-globals.ts'
 * @import { PatchClientResult } from '../src/internal/worker/protocol.ts'
 */
;(() => {
  // @ts-expect-error DevRuntime is declared by the DevEngine prelude this client is injected beside.
  const BaseRuntime = /** @type {DevRuntimeConstructor} */ (DevRuntime)

  class NeemHotContext {
    /**
     * @param {string} moduleId
     * @param {HotData} data
     */
    constructor(moduleId, data) {
      this.moduleId = moduleId
      /** @type {HotAcceptCallback[]} */
      this.callbacks = []
      /** @type {HotDisposer[]} */
      this.disposers = []
      this.data = data
    }

    /** @param {HotDisposer} callback */
    dispose(callback) {
      this.disposers.push(callback)
    }

    prune() {}
    on() {}
    off() {}
    send() {}

    /** @param {unknown} callback */
    accept(callback) {
      if (Array.isArray(callback) || typeof callback === 'string') {
        throw new Error(
          'Neem patching supports only self-accept; dependency accepts are not supported',
        )
      }
      this.callbacks.push({
        deps: [this.moduleId],
        fn:
          typeof callback === 'function'
            ? (modules) => callback(modules[0])
            : () => undefined,
      })
    }

    invalidate() {
      throw new Error(
        'Neem patching does not support import.meta.hot.invalidate()',
      )
    }
  }

  class NeemDevRuntime extends BaseRuntime {
    /** @type {Map<string, NeemHotContext>} */
    hotContexts = new Map()
    // import.meta.hot.data outlives module instances, as in Vite.
    /** @type {Map<string, HotData>} */
    hotData = new Map()

    /** @param {string} moduleId */
    createModuleHotContext(moduleId) {
      let data = this.hotData.get(moduleId)
      if (!data) this.hotData.set(moduleId, (data = {}))
      const context = new NeemHotContext(moduleId, data)
      this.hotContexts.set(moduleId, context)
      return context
    }
  }

  /**
   * @typedef {{ type: 'noop' }
   *   | { type: 'reload', reason: string }
   *   | { type: 'boundaries', boundaries: [string, string][], updateSet: string[] }} PatchPlan
   */

  class NeemPatchClient {
    /** @param {NeemDevRuntime} runtime */
    constructor(runtime) {
      this.runtime = runtime
      this.lastSeq = 0
    }

    /** @param {string} id */
    isSelfAccepted(id) {
      return (
        this.runtime.hotContexts
          .get(id)
          ?.callbacks.some((callback) => callback.deps.includes(id)) ?? false
      )
    }

    /**
     * @param {readonly string[]} changedIds
     * @returns {PatchPlan}
     */
    compute(changedIds) {
      /** @type {[string, string][]} */
      const boundaries = []
      /** @type {Set<string>} */
      const updateSet = new Set()
      /** @type {Set<string>} */
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

    /**
     * @param {string} id
     * @param {string[]} stack
     * @param {Set<string>} updateSet
     * @param {[string, string][]} boundaries
     * @param {Set<string>} traversed
     * @returns {{ type: 'reload', reason: string } | undefined}
     */
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
    /**
     * @param {readonly string[]} changedIds
     * @param {readonly string[]} updateSet
     */
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

    // Every rejection leaves the running generation serving. Once disposers
    // or re-executed modules have run, a failure is an unavailable generation
    // unless the accept callback marks that it failed before retiring it.
    /**
     * @param {WorkerUpdate} update
     * @param {() => Promise<unknown>} load imports the patch file
     * @returns {Promise<PatchClientResult>}
     */
    async apply(update, load) {
      if (update.type === 'Noop')
        return { outcome: 'applied', delivered: false }
      if (update.type === 'FullReload') {
        return rejected(update.reason ?? 'Rolldown requested a full reload')
      }
      if (update.seq !== this.lastSeq + 1) {
        return rejected(
          'Patch sequence gap: expected ' +
            (this.lastSeq + 1) +
            ', received ' +
            update.seq,
        )
      }
      this.lastSeq = update.seq

      const computed = this.compute(update.changedIds)
      if (computed.type === 'reload') return rejected(computed.reason)
      if (computed.type === 'noop') {
        if (!update.changedIds.length) {
          return { outcome: 'applied', delivered: false }
        }
        return rejected(
          'update changes modules that have not run yet: ' +
            update.changedIds.join(', '),
        )
      }

      try {
        await load()
      } catch (error) {
        return rejected('failed to import patch: ' + String(error))
      }

      // The patch registered its factories, but no instance was replaced yet.
      for (const id of computed.updateSet) {
        if (!this.runtime.hasFactory(id)) {
          return rejected('patch has no factory for ' + id, true)
        }
      }
      const unreached = this.unreachedModules(
        update.changedIds,
        computed.updateSet,
      )
      if (unreached.length) {
        return rejected(
          'update changes modules that have not run yet: ' +
            unreached.join(', '),
          true,
        )
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
          if (!context) continue
          for (const dispose of context.disposers) await dispose(context.data)
        }
        for (const id of computed.updateSet) this.runtime.removeModuleCache(id)
        for (const { acceptedVia, callbacks } of applies) {
          this.runtime.initModule(acceptedVia)
          const fresh = this.runtime.loadExports(acceptedVia)
          for (const callback of callbacks) await callback.fn([fresh])
        }
      } catch (error) {
        const mark = /** @type {GenerationIntactMark | undefined} */ (error)
        return {
          outcome:
            mark?.neemGenerationIntact === true ? 'rejected' : 'unavailable',
          delivered: true,
          reason: 'failed to apply patch: ' + String(error),
        }
      }
      return { outcome: 'applied', delivered: true }
    }
  }

  /**
   * @param {string} reason
   * @returns {PatchClientResult}
   */
  function rejected(reason, delivered = false) {
    return { outcome: 'rejected', delivered, reason }
  }

  const patchGlobal =
    /** @type {PatchGlobal & { __rolldown_runtime__?: NeemDevRuntime }} */ (
      globalThis
    )
  const clientId = patchGlobal.__neem_patch_client_id__ ?? crypto.randomUUID()
  const runtime = (patchGlobal.__rolldown_runtime__ ??= new NeemDevRuntime(
    clientId,
  ))
  const client = new NeemPatchClient(runtime)
  runtime.hooks = {
    createModuleHotContext: (id) => runtime.createModuleHotContext(id),
    onModuleCacheRemoval: (id) => runtime.hotContexts.delete(id),
  }
  patchGlobal.__neem_patches__ = {
    clientId,
    apply: (update, load) => client.apply(update, load),
  }
})()
