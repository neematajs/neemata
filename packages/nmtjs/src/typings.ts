import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import dedent from 'dedent'

export async function generateTypings(
  applicationImports: Record<string, { path: string; specifier: string }>,
) {
  await mkdir('.neemata', { recursive: true }).catch(() => {})
  await writeFile(
    resolve('.neemata', 'types.d.ts'),
    dedent`
    /// <reference types="@nmtjs/runtime/types" />

    declare module '@nmtjs/runtime/types' {
      interface Applications {
        ${Object.entries(applicationImports)
          .map(
            ([appName, { specifier }]) =>
              `'${appName}': typeof import('${specifier}').default`,
          )
          .join('\n')}
      }
    }
    `,
  )
}
