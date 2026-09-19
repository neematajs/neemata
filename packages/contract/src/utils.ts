export type ContractSchemaOptions = { title?: string; description?: string }

export const freeze = <T>(schema: T) => Object.freeze(schema) as T

export const concatFullName = (parent: string | undefined, name: string) => {
  return parent ? `${parent}/${name}` : name
}
