import { readFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'

export async function waitForPackages(packages, options = {}) {
  const {
    registry = 'https://registry.npmjs.org',
    timeout = 2 * 60 * 60 * 1000,
    interval = 30 * 1000,
    settle = 60 * 1000,
  } = options
  const pending = new Map(packages)
  const deadline = Date.now() + timeout
  const signal = AbortSignal.timeout(timeout)

  while (pending.size) {
    await Promise.all(
      Array.from(pending, async ([name, version]) => {
        if (await isAvailable(registry, name, version, signal)) {
          pending.delete(name)
        }
      }),
    )
    if (!pending.size) break
    const names = Array.from(pending, ([name, version]) => `${name}@${version}`)
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for npm packages: ${names.join(', ')}`)
    }
    console.log(`Waiting for npm packages: ${names.join(', ')}`)
    await setTimeout(Math.min(interval, deadline - Date.now()))
  }

  // Other registry edges can lag behind the one reached by this release runner.
  await setTimeout(settle)
}

async function isAvailable(registry, name, version, signal) {
  try {
    const url = `${registry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
    const request = {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    }
    const response = await fetch(url, request)
    if (!response.ok) {
      await response.body?.cancel()
      return false
    }
    const manifest = await response.json()
    if (manifest.name !== name || manifest.version !== version) return false
    // Metadata can appear before npm's publish-time scan releases the tarball.
    const tarball = await fetch(manifest.dist.tarball, {
      ...request,
      method: 'HEAD',
    })
    return tarball.ok
  } catch {
    // Registry propagation and transient network failures are retried together.
    return false
  }
}

if (import.meta.main) {
  const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  await waitForPackages(Object.entries(manifest.optionalDependencies))
}
