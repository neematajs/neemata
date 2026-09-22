import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./prepare-release.js', import.meta.url))
const { packageManager } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
)
const { napi } = JSON.parse(
  readFileSync(
    new URL('../packages/proxy/package.json', import.meta.url),
    'utf8',
  ),
)
const platforms = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm-gnueabihf',
  'linux-arm64-gnu',
  'linux-arm64-musl',
  'linux-x64-gnu',
  'linux-x64-musl',
]

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'neem-release-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const files = {
    'package.json': JSON.stringify({
      name: 'release-fixture',
      private: true,
      packageManager,
    }),
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'README.md': 'Workspace documentation',
    'LICENSE.md': 'MIT',
    'packages/prom-client/README.md': 'Prometheus documentation',
    'packages/prom-client/LICENSE': 'Apache-2.0',
    'packages/prom-client/NOTICE': 'Upstream attribution',
    'packages/proxy/dist/index.js': 'module.exports = {}',
    'packages/proxy/dist/index.d.ts': 'export class Proxy {}',
    'packages/proxy/LICENSE.md': 'Proxy MIT license',
  }
  for (const platform of platforms) {
    files[
      `packages/proxy/artifacts/${platform}/neemata-proxy.${platform}.node`
    ] = `test artifact for ${platform}`
  }
  const manifests = {
    'prom-client': { name: '@nmtjs/prom-client', version: '1.0.1' },
    proxy: {
      name: '@nmtjs/proxy',
      version: '1.0.0-beta.7',
      napi,
      files: ['dist/index.js', 'dist/index.d.ts', 'LICENSE.md', 'README.md'],
    },
    neem: {
      name: '@nmtjs/neem',
      peerDependencies: { '@nmtjs/proxy': 'workspace:*' },
      peerDependenciesMeta: { '@nmtjs/proxy': { optional: true } },
    },
    metrics: {
      name: '@nmtjs/metrics',
      dependencies: { '@nmtjs/prom-client': 'workspace:*' },
    },
  }
  for (const [directory, manifest] of Object.entries(manifests)) {
    files[`packages/${directory}/package.json`] = JSON.stringify(manifest)
  }
  for (const [file, contents] of Object.entries(files)) {
    const path = join(root, file)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, contents)
  }
  // Pack through real workspace links, as the release workflows do after install.
  const install = spawnSync(
    'pnpm',
    ['install', '--offline', '--ignore-scripts'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
  assert.equal(install.status, 0, install.stdout + install.stderr)
  return root
}

function manifest(root, directory) {
  return JSON.parse(
    readFileSync(join(root, 'packages', directory, 'package.json'), 'utf8'),
  )
}

function prepare(root, scope, version) {
  return spawnSync(process.execPath, [script, scope, version], {
    cwd: root,
    encoding: 'utf8',
  })
}

function pack(root, name) {
  const path = join(root, 'package.tgz')
  const result = spawnSync(
    'pnpm',
    ['--dir', `packages/${name}`, 'pack', '--out', path],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const archive = spawnSync('tar', ['-xOf', path, 'package/package.json'], {
    encoding: 'utf8',
  })
  assert.equal(archive.status, 0, archive.stderr)
  const contents = spawnSync('tar', ['-tf', path], { encoding: 'utf8' })
  assert.equal(contents.status, 0, contents.stderr)
  return {
    manifest: JSON.parse(archive.stdout),
    files: contents.stdout.split('\n'),
  }
}

void test('stack releases pack independent dependency versions without native artifacts', (t) => {
  const root = fixture(t)
  rmSync(join(root, 'packages/proxy/dist'), { recursive: true })
  rmSync(join(root, 'packages/proxy/artifacts'), { recursive: true })
  const proxy = manifest(root, 'proxy')
  const prom = manifest(root, 'prom-client')

  const result = prepare(root, 'stack', '2.0.0-beta.1')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(manifest(root, 'proxy'), proxy)
  assert.deepEqual(manifest(root, 'prom-client'), prom)
  assert.equal(existsSync(join(root, 'packages/proxy/npm')), false)

  const { manifest: metrics } = pack(root, 'metrics')
  assert.equal(metrics.version, '2.0.0-beta.1')
  assert.equal(metrics.dependencies['@nmtjs/prom-client'], '1.0.1')
  const { manifest: neem } = pack(root, 'neem')
  assert.equal(neem.version, '2.0.0-beta.1')
  assert.equal(neem.peerDependencies['@nmtjs/proxy'], '1.0.0-beta.7')
  assert.equal(neem.peerDependenciesMeta['@nmtjs/proxy'].optional, true)
})

void test('prom-client releases preserve the stack, proxy, license and documentation', (t) => {
  const root = fixture(t)
  rmSync(join(root, 'packages/proxy/dist'), { recursive: true })
  const metrics = manifest(root, 'metrics')
  const proxy = manifest(root, 'proxy')
  const result = prepare(root, 'prom-client', '1.0.2')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(manifest(root, 'prom-client').version, '1.0.2')
  assert.deepEqual(manifest(root, 'metrics'), metrics)
  assert.deepEqual(manifest(root, 'proxy'), proxy)
  const prom = join(root, 'packages/prom-client')
  assert.equal(
    readFileSync(join(prom, 'README.md'), 'utf8'),
    'Prometheus documentation',
  )
  assert.equal(readFileSync(join(prom, 'LICENSE'), 'utf8'), 'Apache-2.0')
  assert.equal(
    readFileSync(join(prom, 'NOTICE'), 'utf8'),
    'Upstream attribution',
  )
  assert.equal(existsSync(join(prom, 'LICENSE.md')), false)
})

void test('proxy releases version the wrapper and bindings together without changing other packages', (t) => {
  const root = fixture(t)
  const metrics = manifest(root, 'metrics')
  const prom = manifest(root, 'prom-client')
  const result = prepare(root, 'proxy', '1.0.0-beta.8')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(manifest(root, 'proxy').version, '1.0.0-beta.8')
  assert.equal(manifest(root, 'proxy/npm/darwin-arm64').version, '1.0.0-beta.8')
  assert.deepEqual(manifest(root, 'metrics'), metrics)
  assert.deepEqual(manifest(root, 'prom-client'), prom)
  assert.deepEqual(
    readdirSync(join(root, 'packages/proxy/npm')).sort(),
    platforms,
  )
  const proxy = pack(root, 'proxy')
  assert.equal(
    Object.keys(proxy.manifest.optionalDependencies).length,
    platforms.length,
  )
  assert.equal(
    proxy.files.some((file) => file.endsWith('.node')),
    false,
  )
  for (const platform of platforms) {
    const binding = pack(root, `proxy/npm/${platform}`)
    const { name, version } = binding.manifest
    assert.equal(name, `@nmtjs/proxy-${platform}`)
    assert.equal(version, '1.0.0-beta.8')
    assert.equal(proxy.manifest.optionalDependencies[name], version)
    assert.ok(binding.files.includes(`package/neemata-proxy.${platform}.node`))
    assert.ok(binding.files.includes('package/LICENSE.md'))
  }
  assert.deepEqual(manifest(root, 'proxy/npm/darwin-arm64').cpu, ['arm64'])
  assert.deepEqual(manifest(root, 'proxy/npm/darwin-arm64').os, ['darwin'])
  assert.deepEqual(manifest(root, 'proxy/npm/linux-x64-gnu').libc, ['glibc'])
  assert.deepEqual(manifest(root, 'proxy/npm/linux-x64-musl').libc, ['musl'])

  // Generated directories must also publish directly outside workspace membership.
  const preview = spawnSync(
    'pnpm',
    [
      '--dir',
      'packages/proxy/npm/linux-x64-musl',
      'publish',
      '--dry-run',
      '--access',
      'public',
      '--provenance',
      '--no-git-checks',
      '--tag',
      'beta',
    ],
    { cwd: root, encoding: 'utf8' },
  )
  assert.equal(preview.status, 0, preview.stdout + preview.stderr)

  // A repeated preparation must drop distribution packages for removed targets.
  const path = join(root, 'packages/proxy/package.json')
  const updated = manifest(root, 'proxy')
  updated.napi.targets = ['aarch64-apple-darwin']
  writeFileSync(path, JSON.stringify(updated))
  for (const platform of platforms) {
    if (platform === 'darwin-arm64') continue
    rmSync(join(root, 'packages/proxy/artifacts', platform), {
      recursive: true,
    })
  }
  const repeat = prepare(root, 'proxy', '1.0.0-beta.9')
  assert.equal(repeat.status, 0, repeat.stderr)
  assert.deepEqual(readdirSync(join(root, 'packages/proxy/npm')), [
    'darwin-arm64',
  ])
  assert.deepEqual(manifest(root, 'proxy').optionalDependencies, {
    '@nmtjs/proxy-darwin-arm64': '1.0.0-beta.9',
  })
})

void test('proxy releases reject incomplete artifacts before changing versions', (t) => {
  const root = fixture(t)
  const proxy = manifest(root, 'proxy')
  rmSync(
    join(
      root,
      'packages/proxy/artifacts/darwin-arm64/neemata-proxy.darwin-arm64.node',
    ),
  )
  const result = prepare(root, 'proxy', '1.0.0-beta.8')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Expected one non-empty proxy binding/)
  assert.deepEqual(manifest(root, 'proxy'), proxy)
  assert.equal(existsSync(join(root, 'packages/proxy/npm')), false)
})
