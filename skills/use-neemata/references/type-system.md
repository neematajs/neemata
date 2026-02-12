---
title: Type System
description: Neemata `t.*` schemas — encode/decode modes, transforms, inference, and Standard Schema (JSON Schema) support.
---

# Type System (`t.*`)

Import from `nmtjs`:

```ts
import { t } from 'nmtjs'
```

A Neemata schema is both:

- A runtime validator (built on `zod/mini`)
- A bidirectional transformer for protocol-safe data

## Encode vs decode “modes”

Each schema supports two transformations:

- `schema.decode(value)` parses **wire format** into **app values**
- `schema.encode(value)` converts **app values** into **wire format**

Example (date + bigint):

```ts
const user = t.object({
  id: t.bigInt(),
  createdAt: t.date(),
  name: t.string(),
})

// Wire → app
const decoded = user.decode({
  id: '123',
  createdAt: '2021-01-01T00:00:00.000Z',
  name: 'Ada',
})
// decoded.id: bigint
// decoded.createdAt: Date

// App → wire
const encoded = user.encode({
  id: 123n,
  createdAt: new Date('2021-01-01T00:00:00.000Z'),
  name: 'Ada',
})
// encoded.id: string
// encoded.createdAt: string
```

### Raw modes

For tooling, Neemata also exposes “raw” inference variants:

- `t.infer.decodeRaw.*` / `t.infer.encodeRaw.*`

These correspond to the underlying Zod input/output types *before/after* Neemata’s transform wiring.

## Builders

### Primitives

```ts
t.string()
  .min(n)
  .max(n)
  .pattern(pattern)
  .email()
  .url()
  .uuid()
  .ipv4()
  .ipv6()
  .nanoid()
  .cuid()
  .cuid2()
  .e164()
  .jwt()
  .base64()
  .base64URL()
  .emoji()

t.number().positive().negative().gt(n).gte(n).lt(n).lte(n)

t.integer()

t.bigInt() // bigint ↔ numeric string

t.boolean()

t.null()

t.any()

t.never()
```

### Composites

```ts
t.object({ key: t.string(), age: t.number() })

t.array(t.string()).min(n).max(n).length(n)

t.tuple([t.string(), t.number()])

t.enum(['a', 'b', 'c'] as const)

t.union(t.string(), t.number())

t.literal('hello')
```

### Special types

```ts
t.date() // Date ↔ ISO date/datetime string

t.custom({
  decode: (wire) => appValue,
  encode: (appValue) => wire,
  validation: (value, ctx) => { /* optional */ },
  error: 'Optional error message',
  prototype: SomeClass.prototype, // optional
})
```

### Modifiers (available on any schema)

```ts
.optional()     // T | undefined
.nullable()     // T | null
.nullish()      // T | null | undefined
.default(value)

.title('Name')
.description('...')
.examples(a, b, c)
.meta({ ... })
```

## Type inference

Use `t.infer.*` to infer types for each mode:

```ts
type DecodeInput = t.infer.decode.input<typeof user>
type DecodeOutput = t.infer.decode.output<typeof user>

type EncodeInput = t.infer.encode.input<typeof user>
type EncodeOutput = t.infer.encode.output<typeof user>

type DecodeRawInput = t.infer.decodeRaw.input<typeof user>
type DecodeRawOutput = t.infer.decodeRaw.output<typeof user>

type EncodeRawInput = t.infer.encodeRaw.input<typeof user>
type EncodeRawOutput = t.infer.encodeRaw.output<typeof user>
```

## Standard Schema v1 support (and JSON Schema)

Every Neemata type implements Standard Schema v1 and exposes JSON Schema helpers.

### Getting a Standard Schema

- Default (decode) schema:

```ts
const standard = user['~standard']
// Equivalent to: user.standard.decode['~standard']
```

- Explicit mode:

```ts
const decodeStandard = user.standard.decode['~standard']
const encodeStandard = user.standard.encode['~standard']
```

### Validation

`validate()` returns either `{ value }` or `{ issues }`:

```ts
const ok = await decodeStandard.validate({
  id: '123',
  createdAt: '2021-01-01T00:00:00.000Z',
  name: 'Ada',
})

if ('value' in ok) {
  // ok.value is decoded app value
}

const bad = await decodeStandard.validate({ id: 'nope', createdAt: 'bad', name: 123 })
if ('issues' in bad) {
  // bad.issues: array of { message, path? }
}
```

### JSON Schema generation

```ts
const inputJsonSchema = decodeStandard.jsonSchema.input({ target: 'draft-07' })
const outputJsonSchema = decodeStandard.jsonSchema.output({ target: 'draft-07' })
```

`jsonSchema.*` also supports `libraryOptions.json` for Zod’s JSON schema settings (e.g. `cycles`, `reused`).
