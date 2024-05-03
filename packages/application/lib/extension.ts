import type { ExtensionApplication } from './types'

export abstract class BaseExtension<Options = unknown, Extra = {}> {
  constructor(
    public readonly application: ExtensionApplication,
    public readonly options: Options,
  ) {}

  readonly _!: { options: Options } & Extra
  abstract name: string
}
