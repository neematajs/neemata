import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'rolldown'
import { describe, expect, it } from 'vitest'

const workspaceRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const workspacePath = (...segments: string[]) =>
  resolve(workspaceRoot, ...segments)

const aliases = new Map([
  [
    '@nmtjs/transports/neemata/http',
    workspacePath('packages/transports/src/neemata/http/index.ts'),
  ],
  [
    '@nmtjs/client/http',
    workspacePath('packages/client/src/transports/http/index.ts'),
  ],
  [
    '@nmtjs/protocol/json/client',
    workspacePath('packages/protocol/src/json/client.ts'),
  ],
  [
    '@nmtjs/protocol/json/server',
    workspacePath('packages/protocol/src/json/server.ts'),
  ],
  [
    '@nmtjs/protocol/client',
    workspacePath('packages/protocol/src/client/index.ts'),
  ],
  [
    '@nmtjs/protocol/server',
    workspacePath('packages/protocol/src/server/index.ts'),
  ],
  ['@nmtjs/protocol', workspacePath('packages/protocol/src/common/index.ts')],
])

const collectReachableModules = async (entry: string) => {
  const loaded = new Set<string>()

  await build({
    input: 'virtual:codec-reachability',
    platform: 'node',
    external: (id) => id.startsWith('@nmtjs/') && !aliases.has(id),
    plugins: [
      {
        name: 'codec-reachability',
        resolveId(id) {
          if (id === 'virtual:codec-reachability') return id
          return aliases.get(id)
        },
        load(id) {
          if (id === 'virtual:codec-reachability') return entry
        },
        transform(_code, id) {
          loaded.add(id)
        },
      },
    ],
    output: { format: 'esm' },
  })

  return [...loaded]
}

const expectNoMessagePack = (loaded: string[]) => {
  expect(
    loaded.some(
      (id) =>
        id.includes('/protocol/src/msgpack/') ||
        id.includes('/node_modules/@msgpack/msgpack/'),
    ),
  ).toBe(false)
}

describe('codec subpath reachability', () => {
  it('keeps concrete codecs out of the native HTTP handler graph', async () => {
    const loaded = await collectReachableModules(`
      import { neemataHttp } from '@nmtjs/transports/neemata/http'
      export default neemataHttp
    `)

    expect(loaded.some((id) => id.includes('/protocol/src/json/'))).toBe(false)
    expectNoMessagePack(loaded)
  })

  it('includes only the selected JSON codec in an HTTP client graph', async () => {
    const loaded = await collectReachableModules(`
      import { HttpTransportFactory } from '@nmtjs/client/http'
      import { JsonCodec } from '@nmtjs/protocol/json/client'
      export { HttpTransportFactory, JsonCodec }
    `)

    expect(loaded).toContain(
      workspacePath('packages/protocol/src/json/client.ts'),
    )
    expect(loaded.some((id) => id.includes('/client/src/transports/ws/'))).toBe(
      false,
    )
    expectNoMessagePack(loaded)
  })
})
