import { BaseExtension, Hook } from '#application'

export type StaticTypingsExtensionOptions = {
  emit: boolean
  path: string | string[]
}

export class StaticTypingsExtension extends BaseExtension<StaticTypingsExtensionOptions> {
  name = 'Static typings'

  initialize() {
    if (this.options.emit) {
      this.application.registry.hooks.add(Hook.AfterInitialize, async () => {
        const procedures = this.application.registry.procedures

        const paths = Array.isArray(this.options.path)
          ? this.options.path
          : [this.options.path]

        // for (const procedure of procedures) {

        // }
      })
    }
  }
}
