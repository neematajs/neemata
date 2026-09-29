/**
 * Imports a patch file. The compiler writes it before any thread hears about
 * it, so a first "not found" means a stale resolver cache, not a missing file.
 *
 * Bun resolves through one directory cache shared by every thread. A thread
 * that misses a file in a cached directory evicts that directory and resolves
 * again, but only while it is still cached: when threads miss at once, one
 * evicts and the rest report the module missing. Each thread of a runtime gets
 * its own new patch file in the same directory at the same moment. By the
 * second attempt the directory is either re-read or evicted, so it resolves.
 */
export async function importPatch(
  url: string,
  importModule: (url: string) => Promise<unknown> = (url) => import(url),
): Promise<unknown> {
  try {
    return await importModule(url)
  } catch (error) {
    if ((error as { code?: unknown })?.code !== 'ERR_MODULE_NOT_FOUND') {
      throw error
    }
    return await importModule(url)
  }
}
