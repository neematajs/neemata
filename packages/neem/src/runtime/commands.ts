export type NeemCommandContext = { mode: 'development' | 'production' }

export type NeemCommandDefinition = {
  name: string
  description?: string
  run: (args: unknown, ctx: NeemCommandContext) => Promise<void> | void
}

export type NeemCommandsConfig = NeemCommandDefinition[]
