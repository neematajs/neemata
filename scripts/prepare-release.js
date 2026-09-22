import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'
import { parseArgs } from 'node:util'

const { positionals } = parseArgs({ allowPositionals: true })
const [scope, version] = positionals
if (!['stack', 'proxy', 'prom-client'].includes(scope) || !version) {
  throw new Error(
    'Usage: node scripts/prepare-release.js <stack|proxy|prom-client> <version>',
  )
}

const root = process.cwd()
const proxy = join(root, 'packages/proxy')
let packages
if (scope === 'stack') {
  // Standalone packages keep their own versions when the Neem stack releases.
  packages = readdirSync(join(root, 'packages'))
    .filter((name) => name !== 'proxy' && name !== 'prom-client')
    .map((name) => join(root, 'packages', name))
} else {
  packages = [join(root, 'packages', scope)]
}

if (scope === 'proxy') {
  const manifest = JSON.parse(readFileSync(join(proxy, 'package.json'), 'utf8'))
  // Fail before changing release metadata if any native build is missing.
  for (const name of Object.keys(manifest.optionalDependencies)) {
    const target = name.slice('@nmtjs/proxy-'.length)
    const directory = join(proxy, 'npm', target)
    const binary = join(directory, `${manifest.napi.binaryName}.${target}.node`)
    if (!existsSync(binary) || statSync(binary).size === 0) {
      throw new Error(`Missing proxy binding: ${binary}`)
    }
    packages.push(directory)
  }
  for (const file of ['index.js', 'index.d.ts']) {
    const path = join(proxy, 'dist', file)
    if (!existsSync(path) || statSync(path).size === 0) {
      throw new Error(`Missing proxy loader: ${path}`)
    }
  }
}

for (const directory of packages) {
  const path = join(directory, 'package.json')
  if (!existsSync(path)) continue
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  if (pkg.private) continue
  pkg.version = version
  pkg.repository = {
    type: 'git',
    url: 'https://github.com/neematajs/neemata',
    directory: relative(root, directory),
  }
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`)

  // Imported packages retain their documentation, licensing and attribution.
  if (!existsSync(join(directory, 'README.md'))) {
    copyFileSync(join(root, 'README.md'), join(directory, 'README.md'))
  }
  if (
    !existsSync(join(directory, 'LICENSE')) &&
    !existsSync(join(directory, 'LICENSE.md'))
  ) {
    copyFileSync(join(root, 'LICENSE.md'), join(directory, 'LICENSE.md'))
  }
}
