import type {
  ApplicationAdapter,
  ApplicationDefinition,
  ApplicationRuntime,
} from './types.ts'
import { kApplicationDefinition } from './constants.ts'

export type ApplicationDefinitionWithMarker<
  TAdapter extends ApplicationAdapter = ApplicationAdapter,
> = ApplicationDefinition<TAdapter> & {
  readonly [kApplicationDefinition]: true
}

export function defineApplication<
  TAdapter extends ApplicationAdapter,
>(options: {
  adapter: TAdapter
  definition: TAdapter extends ApplicationAdapter<
    string,
    infer TDefinition,
    any
  >
    ? TDefinition
    : never
}): ApplicationDefinitionWithMarker<TAdapter> {
  return Object.freeze({
    [kApplicationDefinition]: true,
    adapter: options.adapter,
    definition: options.definition,
  })
}

export function isApplicationDefinition(
  value: unknown,
): value is ApplicationDefinitionWithMarker {
  return Boolean(
    value && typeof value === 'object' && kApplicationDefinition in value,
  )
}

export async function createApplicationRuntime<
  TAdapter extends ApplicationAdapter,
>(
  applicationName: string,
  application: ApplicationDefinition<TAdapter>,
  mode: 'development' | 'production',
  threadOptions: TAdapter extends ApplicationAdapter<
    string,
    any,
    infer TThreadOptions
  >
    ? TThreadOptions
    : never,
): Promise<ApplicationRuntime> {
  return await application.adapter.createRuntime({
    applicationName,
    definition: application.definition,
    mode,
    threadOptions,
  })
}
