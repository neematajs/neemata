// FIXME: workaround for a Bun resolver race (seen on 1.3.14 and every 1.4.x).
// Remove the retry once Bun stops reporting files on disk as missing when
// threads resolve from one directory at once. Details, a standalone repro and
// removal steps: https://github.com/neematajs/neemata/issues/469
// Only Bun's resolver shares a directory cache between threads; elsewhere a
// missing patch is a real failure and is reported on the first attempt.
const RETRY_MISSING = process.versions.bun !== undefined

/**
 * Imports a patch file. The compiler writes it before any thread hears about
 * it, so on Bun a first "not found" means a stale resolver cache, not a
 * missing file.
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
  retryMissing = RETRY_MISSING,
): Promise<unknown> {
  try {
    return await importModule(url)
  } catch (error) {
    if (
      !retryMissing ||
      (error as { code?: unknown })?.code !== 'ERR_MODULE_NOT_FOUND'
    ) {
      throw error
    }
    return await importModule(url)
  }
}
