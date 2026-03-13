import type {
  ApplicationAdapter,
  ApplicationDefinition,
  ApplicationRuntime,
} from '../types.ts'
import type { ApplicationDefinitionWithMarker } from './config.ts'
import { kApplicationConfig, kApplicationDefinition } from './constants.ts'

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
