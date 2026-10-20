import { describe, expect, it } from 'vitest'

import {
  withoutInspectorFlags,
  withoutInspectorNodeOptions,
} from '../../src/internal/commands/preview.ts'

describe('preview build flags', () => {
  it('drops inspector flags together with a separate value', () => {
    expect(
      withoutInspectorFlags([
        '--inspect-port',
        '0',
        '--inspect=9230',
        '--inspect-brk',
        '--debug-port=1',
        '--inspect-publish-uid',
        'http',
        '--import',
        './loader.mjs',
        '--conditions=development',
      ]),
    ).toEqual(['--import', './loader.mjs', '--conditions=development'])
  })

  it('keeps a value that only follows a flag without one', () => {
    // `--inspect` takes only `=value`; the next argument is its own option.
    expect(
      withoutInspectorFlags(['--inspect', '--enable-source-maps']),
    ).toEqual(['--enable-source-maps'])
  })

  it('removes inspector options from NODE_OPTIONS and keeps the rest verbatim', () => {
    expect(
      withoutInspectorNodeOptions(
        '--inspect-brk=0 --import "./my loader.mjs"  --inspect-port 9300 --conditions=dev',
      ),
    ).toBe('--import "./my loader.mjs" --conditions=dev')
    expect(
      withoutInspectorNodeOptions('"--inspect" --max-old-space-size=4096'),
    ).toBe('--max-old-space-size=4096')
  })

  it('returns NODE_OPTIONS untouched when nothing is removed', () => {
    const value = '--import  ./a.mjs'
    expect(withoutInspectorNodeOptions(value)).toBe(value)
  })
})
