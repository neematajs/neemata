import type { FactoryInjectable } from '@nmtjs/core'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { createFactoryInjectable } from '@nmtjs/core'

export type ConfigSchema = StandardSchemaV1

/**
 * A schema alone binds the record key as the environment variable name;
 * the object form decouples them (e.g. `dbUrl` reading `DATABASE_URL`).
 */
export type EnvConfigVariable =
  | ConfigSchema
  | { name: string; schema: ConfigSchema }

export type EnvConfigVariables = Record<string, EnvConfigVariable>

export type EnvConfigSource = Record<string, string | undefined>

export type InferEnvConfig<Variables extends EnvConfigVariables> = {
  [K in keyof Variables]: Variables[K] extends ConfigSchema
    ? StandardSchemaV1.InferOutput<Variables[K]>
    : Variables[K] extends { schema: infer Schema extends ConfigSchema }
      ? StandardSchemaV1.InferOutput<Schema>
      : never
}

export interface EnvConfigOptions {
  /**
   * Environment variables are read from `process.env` unless a custom
   * source is given (tests, pre-resolved env snapshots).
   */
  source?: EnvConfigSource
}

export class EnvConfigError extends Error {
  override name = 'EnvConfigError'
  /** Validation issues keyed by environment variable name. */
  readonly issues: Readonly<Record<string, readonly StandardSchemaV1.Issue[]>>

  constructor(issues: Record<string, readonly StandardSchemaV1.Issue[]>) {
    super(formatIssues(issues))
    this.issues = Object.freeze(issues)
  }
}

export function createEnvConfig<Variables extends EnvConfigVariables>(
  variables: Variables,
  options: EnvConfigOptions = {},
): FactoryInjectable<InferEnvConfig<Variables>> {
  return createFactoryInjectable<InferEnvConfig<Variables>>({
    create: () => resolveEnvConfig(variables, options.source),
  })
}

export async function resolveEnvConfig<Variables extends EnvConfigVariables>(
  variables: Variables,
  source: EnvConfigSource = process.env,
): Promise<InferEnvConfig<Variables>> {
  const config: Record<string, unknown> = {}
  const issues: Record<string, readonly StandardSchemaV1.Issue[]> = {}

  for (const [key, variable] of Object.entries(variables)) {
    const { name, schema } = isConfigSchema(variable)
      ? { name: key, schema: variable }
      : variable
    // Standard Schema allows async validation, so resolution is async even
    // though most validators (including @nmtjs/type) are synchronous.
    let result = schema['~standard'].validate(source[name])
    if (result instanceof Promise) result = await result
    // Collect issues across all variables instead of failing on the first
    // one, so a misconfigured environment is reported in a single pass.
    if (result.issues) issues[name] = result.issues
    else config[key] = result.value
  }

  if (Object.keys(issues).length > 0) throw new EnvConfigError(issues)
  return config as InferEnvConfig<Variables>
}

const isConfigSchema = (
  variable: EnvConfigVariable,
): variable is ConfigSchema => '~standard' in variable

function formatIssues(
  issues: Record<string, readonly StandardSchemaV1.Issue[]>,
): string {
  const lines: string[] = []
  for (const [name, variableIssues] of Object.entries(issues)) {
    for (const issue of variableIssues) {
      const path = issue.path
        ?.map((segment) =>
          typeof segment === 'object' ? String(segment.key) : String(segment),
        )
        .join('.')
      lines.push(
        path
          ? `${name} (${path}): ${issue.message}`
          : `${name}: ${issue.message}`,
      )
    }
  }
  return `Failed to resolve environment configuration:\n  ${lines.join('\n  ')}`
}
