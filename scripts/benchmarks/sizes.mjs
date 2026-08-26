import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { gzipSync } from 'node:zlib'

import { readJson, toPosixPath } from './utils.mjs'

const RELEASE_COPIED_FILES = new Set(['LICENSE.md', 'README.md'])

export async function runSizeBenchmarks(root) {
  const packagesRoot = resolve(root, 'packages')
  const packageDirectories = (
    await readdir(packagesRoot, { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(packagesRoot, entry.name))
    .sort()
  const cases = []

  for (const packageDirectory of packageDirectories) {
    const packageJsonPath = resolve(packageDirectory, 'package.json')
    const packageJson = await readJson(packageJsonPath).catch(() => undefined)
    if (!packageJson?.name) continue

    const files = [packageJsonPath]
    for (const entry of packageJson.files ?? []) {
      if (RELEASE_COPIED_FILES.has(entry)) continue
      const path = resolve(packageDirectory, entry)
      const pathStat = await stat(path).catch(() => undefined)
      if (!pathStat) {
        throw new Error(
          `${packageJson.name} publish path is missing: ${toPosixPath(relative(root, path))}. Run the build before size benchmarks.`,
        )
      }
      if (pathStat.isDirectory()) files.push(...(await collectFiles(path)))
      else if (pathStat.isFile()) files.push(path)
    }

    let rawBytes = 0
    let gzipBytes = 0
    for (const file of files) {
      const content = await readFile(file)
      rawBytes += content.byteLength
      gzipBytes += gzipSync(content, { level: 9 }).byteLength
    }

    cases.push(
      sizeCase(packageJson.name, 'raw-bytes', rawBytes, 'size-bytes', 'bytes'),
      sizeCase(
        packageJson.name,
        'gzip-bytes',
        gzipBytes,
        'size-bytes',
        'bytes',
      ),
      sizeCase(
        packageJson.name,
        'file-count',
        files.length,
        'size-files',
        'files',
      ),
    )
  }

  return cases
}

function sizeCase(packageName, metric, value, category, unit) {
  return {
    category,
    id: `${packageName} > published ${metric}`,
    metric,
    name: `${packageName} published ${metric}`,
    unit,
    value,
  }
}

async function collectFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectFiles(path)))
    else if (entry.isFile()) files.push(path)
  }
  return files.sort((left, right) => left.localeCompare(right))
}
