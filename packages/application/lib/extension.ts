import type { ExtensionApplication } from './types'

export abstract class BaseExtension<Options = unknown, Extra = {}> {
  constructor(
    public readonly application: ExtensionApplication,
    public readonly options: Options,
  ) {
    // @ts-expect-error
    application.logger.setBindings({ $group: this.name })
    this.initialize?.()
  }

  readonly _!: { options: Options } & Extra
  abstract name: string
  initialize?(): any
}
