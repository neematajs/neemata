# Type System (`t.*`)

Use `t` from `nmtjs` in end-user Neemata examples.

```ts
import { t } from 'nmtjs'
```

Schemas are runtime validators and bidirectional protocol transformers:

- `schema.decode(value)` parses wire format into app values.
- `schema.encode(value)` converts app values into wire format.
- `schema['~standard']` is Standard Schema decode mode.
- `schema.standard.encode` and `schema.standard.decode` expose explicit modes.

```ts
const user = t.object({
  id: t.bigInt(),
  createdAt: t.date(),
  name: t.string(),
})

const decoded = user.decode({
  id: '123',
  createdAt: '2021-01-01T00:00:00.000Z',
  name: 'Ada',
})
// decoded.id: bigint
// decoded.createdAt: Date

const encoded = user.encode({
  id: 123n,
  createdAt: new Date('2021-01-01T00:00:00.000Z'),
  name: 'Ada',
})
// encoded.id: string
// encoded.createdAt: string
```

## Builders

Primitives and transformed primitives:

```ts
t.string()
t.number()
t.integer()
t.boolean()
t.date()
t.bigInt()
t.literal('admin')
t.enum(['draft', 'published'])
t.null()
t.never()
t.any()
t.unknown()
```

Strings:

```ts
t.string().min(1).max(255).pattern(/^user_/)
t.string().email().url().uuid()
t.string().ipv4().ipv6()
t.string().emoji().nanoid().cuid().cuid2()
t.string().e164().jwt().base64().base64URL()
```

Numbers:

```ts
t.number().positive().negative()
t.number().gt(0).gte(0).lt(100).lte(100)
t.integer().positive()
```

Collections and objects:

```ts
t.array(t.string()).min(1).max(10).length(3)
t.tuple([t.string(), t.number()])
t.tuple([t.string()], t.number())
t.object({ id: t.string(), age: t.integer().optional() })
t.looseObject({ id: t.string() })
t.record(t.string(), t.number())
```

Object helpers:

```ts
const base = t.object({
  id: t.string(),
  email: t.string().email(),
  role: t.enum(['admin', 'user']),
})

t.keyof(base)
t.pick(base, { id: true, email: true })
t.omit(base, { role: true })
t.extend(base, { active: t.boolean() })
t.merge(base, t.object({ active: t.boolean() }))
t.partial(base)
```

Unions and intersections:

```ts
t.union(t.string(), t.number())
t.or(t.string(), t.number())
t.intersection(t.object({ id: t.string() }), t.object({ name: t.string() }))
t.and(t.object({ id: t.string() }), t.object({ name: t.string() }))
t.discriminatedUnion(
  'type',
  t.object({ type: t.literal('created'), id: t.string() }),
  t.object({ type: t.literal('deleted'), id: t.string() }),
)
```

Modifiers available on every schema:

```ts
t.string().optional()
t.string().nullable()
t.string().nullish()
t.string().default('anonymous')
t.string().title('User name')
t.string().description('Display name')
t.string().examples('Ada', 'Grace')
t.string().meta({ examples: ['Ada'] })
```

Custom transforms:

```ts
const cents = t.custom({
  decode: (value: string) => Number(value),
  encode: (value: number) => value.toString(),
})

cents.decode('123') // number
cents.encode(123) // string
```

Use `type`, `validation`, `error`, and `prototype` in `t.custom(...)` only when
the transform needs low-level validation or class behavior.

## Procedure Boundary

- Input schemas decode inbound payload before guards and handlers.
- Output schemas encode and validate handler returns and stream chunks.
- `t.date()` and `t.bigInt()` are app values in handlers, encoded wire values
  across the protocol.
- `t.object(...)` strips unknown keys; `t.looseObject(...)` preserves them.
- If output serialization is disabled with config metadata, handler must return
  transport-ready values.

## Inference

Use decode output for handler input and encode input for handler output when
writing helper types:

```ts
type UserDecodeInput = t.infer.decode.input<typeof user>
type UserInput = t.infer.decode.output<typeof user>
type UserOutput = t.infer.encode.input<typeof user>
type UserWire = t.infer.encode.output<typeof user>
```

## Standard Schema And JSON Schema

Default Standard Schema mode is decode:

```ts
const standard = user['~standard']
const result = standard.validate({
  id: '123',
  createdAt: '2021-01-01T00:00:00.000Z',
  name: 'Ada',
})

if ('value' in result) {
  result.value.createdAt // Date
}
```

Use explicit encode/decode modes when integrating with tools:

```ts
const decodeStandard = user.standard.decode['~standard']
const encodeStandard = user.standard.encode['~standard']

const decodeInputSchema = decodeStandard.jsonSchema.input({
  target: 'draft-07',
})
const encodeOutputSchema = encodeStandard.jsonSchema.output({
  target: 'draft-07',
})
```

JSON Schema helpers also accept `libraryOptions.json` for Zod JSON Schema
settings such as `cycles` and `reused`.

## Errors

`schema.encode(...)`, `schema.decode(...)`, and Standard Schema validation use
Zod validation under the hood. Direct encode/decode calls throw
`t.NeemataTypeError` on invalid data; Standard Schema returns `{ issues }`.

```ts
try {
  user.decode({ id: 'nope' })
} catch (error) {
  if (error instanceof t.NeemataTypeError) {
    // inspect error.issues
  }
}
```

## Direct Package Import

Use `@nmtjs/type` only in package-level code that intentionally depends on the
type package directly. For end-user application docs, prefer `nmtjs`.
