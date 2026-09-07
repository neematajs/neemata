# Type System (`t.*`)

Use `t` from `nmtjs` in end-user Neemata examples.

```ts
import { t } from 'nmtjs'
```

Each `t.*` value exposes wire encoding, wire decoding, and runtime parsing as
explicit callable Standard Schemas:

- `schema.decode(value)` parses wire format into app values.
- `schema.encode(value)` converts app values into wire format.
- `schema.parse(value)` validates app values without invoking wire transforms.
- `schema.decode` is a `WireSchema.Decode` Standard Schema.
- `schema.encode` is a `WireSchema.Encode` Standard Schema.

The codec itself deliberately has no default `~standard` direction. Pick
`.decode`, `.encode`, or `.parse` whenever an API accepts a one-way schema.

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

const checked = user.parse(decoded)
// checked.id: bigint; checked.createdAt: Date
// An ISO string is not a valid runtime Date.
```

All three callables accept `unknown` and return their inferred parsed output,
throwing `NeemataTypeError` for invalid values. Runtime parsing preserves defaults,
optional/nullable fields, and collection constraints. Like other parsers, it may
clone objects, strip unknown object keys, or normalize values through the supplied
runtime schema; it does not promise object identity.

For asynchronous constraints, use the Standard Schema validation API or
`validateSchema` from `@nmtjs/common/schema`:

```ts
const result = await user.parse['~standard'].validate(input)
// { value: ... } or { issues: ... }
```

`schema.runtimeZodType` exposes the underlying runtime parser, including Zod's
`parseAsync` and compilation APIs. Custom `BaseType` subclasses must supply
`runtimeZodType` explicitly to the constructor.

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
t.string()
  .min(1)
  .max(255)
  .pattern(/^user_/)
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
import { number, string } from 'zod/mini'

const cents = t.custom({
  decode: { type: number(), transform: Number },
  encode: { type: string(), transform: String },
})

cents.decode('123') // number
cents.encode(123) // string
cents.parse(123) // number
```

Each direction requires its output schema in `type` and conversion in `transform`.
`decode.type` validates runtime values; `encode.type` validates wire values.
Decoding validates the wire input, transforms it, then validates the runtime output.
Encoding validates the runtime input, transforms it, then validates the wire output.
Runtime parsing uses `decode.type` without either wire transform.
The parser cannot derive validation from a TypeScript type or a conversion function.
Use `error` or `prototype` for custom errors or class behavior.

A `validation` function defines shared runtime constraints and runs during runtime
parsing, encoding, and decoding. The object form combines shared and directional
constraints:

```ts
validation: {
  runtime(value, ctx) { /* shared runtime constraints */ },
  decode(value, ctx) { /* additional incoming constraints */ },
  encode(value, ctx) { /* additional outgoing constraints */ },
}
```

Put shared constraints on `decode.type`, `validation`, or `validation.runtime`.
The runtime parser does not execute `validation.decode` or `validation.encode`.
For built-in blobs, instance validation is shared; `maxSize` remains an incoming
wire restriction.

## Procedure Boundary

- Procedure inputs accept a decode schema or a full codec. Full codecs use
  their `.decode` direction.
- Procedure outputs accept an encode schema or a full codec. Full codecs use
  their `.encode` direction.
- Runtime clients require full codecs because they execute both directions;
  static clients can use directional schemas for type inference alone.
- `createProcedure(...)` without an explicit output uses an encode-only
  passthrough schema. Its handler must already return a transport-ready value;
  provide a full output codec when the contract will be used by RuntimeClient.
- `t.date()` and `t.bigInt()` are app values in handlers, encoded wire values
  across the protocol.
- `t.object(...)` strips unknown keys; `t.looseObject(...)` preserves them.
- If output serialization is disabled with config metadata, handler must return
  transport-ready values.

## Inference

`t.infer` remains a provider-specific convenience:

```ts
type UserRuntimeInput = t.infer.parse.input<typeof user>
type UserRuntimeOutput = t.infer.parse.output<typeof user>
type UserDecodeInput = t.infer.decode.input<typeof user>
type UserInput = t.infer.decode.output<typeof user>
type UserOutput = t.infer.encode.input<typeof user>
type UserWire = t.infer.encode.output<typeof user>
```

## Standard Schema And JSON Schema

Use either codec direction as a Standard Schema:

```ts
const standard = user.decode['~standard']
const result = await standard.validate({
  id: '123',
  createdAt: '2021-01-01T00:00:00.000Z',
  name: 'Ada',
})

if ('value' in result) {
  result.value.createdAt // Date
}
```

Standard JSON Schema is an optional capability of a directional schema. The
`t.*` provider exposes it on all three parsers:

```ts
const decodeStandard = user.decode['~standard']
const encodeStandard = user.encode['~standard']

const decodeInputSchema = decodeStandard.jsonSchema.input({
  target: 'draft-07',
})
const encodeOutputSchema = encodeStandard.jsonSchema.output({
  target: 'draft-07',
})
```

JSON Schema helpers also accept `libraryOptions.json` for Zod JSON Schema
settings such as `cycles` and `reused`. Conversion is strict by default and
throws when a boundary cannot be represented faithfully. Neemata runtime
validation does not require JSON Schema support.

Titles and descriptions are preserved on both directions, including nested
transformed fields. Both `.examples(...values)` and `.meta({ examples: values })`
accept runtime values, validate and encode them once, and attach the results to
the wire value schemas. Examples are emitted on decode-input and encode-output
JSON Schema projections, including examples on entire objects and collections.
Runtime projections retain titles and descriptions without wire examples.
`libraryOptions.json.override` is passed directly to Zod's converter.

Framework-neutral helpers and contracts are available from
`@nmtjs/common/schema`:

```ts
import type { Schema, WireSchema } from '@nmtjs/common/schema'

type RuntimeValue<S extends Schema> = Schema.Output<S>
type IncomingWire<C extends WireSchema.Codec> = WireSchema.DecodeInput<C>
type OutgoingWire<C extends WireSchema.Codec> = WireSchema.EncodeOutput<C>
```

## Errors

The `t.*` provider's callable `schema.encode(...)` and `schema.decode(...)`
helpers use Zod validation under the hood and throw `t.NeemataTypeError` on
invalid data. Standard Schema validation returns `{ issues }` and may be
asynchronous.

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
