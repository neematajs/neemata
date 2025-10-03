export type ContractSchemaOptions = { title?: string; description?: string }

export const applyNames = <T extends Record<string, { serviceName?: string }>>(
  params: T,
  opts: { serviceName?: string; subscriptionName?: string },
) => {
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, { ...v, name: k, ...opts }]),
  )
}

export const createSchema = <T>(schema: T) => Object.freeze(schema) as T

export const concatFullName = (parent: string | undefined, name: string) => {
  return parent ? `${parent}/${name}` : name
}
