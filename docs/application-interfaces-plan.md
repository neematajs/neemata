# Application Interfaces — Refactor Plan

Status: direction approved (v2) — the out-of-Neemata consumer API (Slice E) is
approved in direction but its exact shape may still be revised
Date: 2026-08-21
Baseline: `784a1d77`

Supersedes both the original "Neemata Application Interfaces" proposal and v1 of this
plan. The proposal's diagnosis was verified against the code and stands (router =
execution registry = public API; handlers assume they expose the RPC router; no
per-procedure exposure control). Its prescription — a first-class interface-definition
layer — was explored through three API iterations and rejected; the reasoning is
preserved in Appendix A.

## Identity statement

**Neemata is an RPC kernel, not a web framework.** Its projections are the protocols
that share RPC's shape — name + typed input → typed output (or output stream):

- **native** (WS + native HTTP) — the first-party protocol; exposes the whole router
- **JSON-RPC** — the standard-encoding projection of the same surface
- **MCP** — a curated projection of selected unary procedures for agents
- **gRPC** — maps naturally when wanted; deferred behind a re-evaluation gate

**HTTP resource semantics (methods, paths, params, statuses) are not a Neemata
projection.** Every hard design problem of v1 — route bindings, input assembly,
schema-aware coercion, query flatness, path-param typing, rou3 — existed only to
serve HTTP; JSON-RPC and MCP needed none of it. Instead, genuinely HTTP-shaped APIs
are built with a dedicated HTTP framework (Hono, Fastify, Elysia, …) running as a
sibling runtime under Neem, consuming the same domain code through first-class
container/procedure access (Slice E).

## Final model

A strict layering; each level adds exactly one concern:

    Injectables / services  @nmtjs/core — DI providers; logic that was never an operation
    Handler                 @nmtjs/core (createHandler, injectables.ts:70-101)
    └─ dependencies + function; internal building block (workflows consume these
       with their own contract layer)
    Procedure | Stream      @nmtjs/application + @nmtjs/contract
    └─ + input/output contract, guards, middleware, timeout — THE reusable unit:
       a contracted, policied, injectable-aware function. Everything below is
       "this, plus naming and position"
    Router                  canonical tree: policy inheritance (guards/middleware/meta
    └─ per level) + native naming. Multi-mount of one procedure at several positions
       (different policy chains) is legal
    Projections             native (structural, expose-all), JSON-RPC (structural,
    └─ handler-level config), MCP (curated handler-level map)
    Transport handlers      @nmtjs/transports — wire protocols on the shared ServerHost
    ServerHost              unchanged (PR #314 model)

There is **no binding mechanism**: no tokens, no router `.bind`, no surface objects,
no route wrappers. The router and procedure APIs are unchanged except for the
`stream` kind (Slice A). Per-protocol configuration lives on each handler, in
whatever shape is natural for that protocol.

## Decision record

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                        | Rationale                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Route **kinds** (`neemata:procedure`, `neemata:stream`) replace `stream: true`                                                                                                                                                                                                                                                                                                  | Kinds make protocol compatibility a structural type constraint; matches the existing `client.call.*` / `client.stream.*` split                                                                                                                                       |
| D2  | Keep the name "procedure"; the stream kind is named `stream`, not `subscription`                                                                                                                                                                                                                                                                                                | `subscription` reserved for a possible future kind with resubscribe semantics, buildable on the untouched pubsub channel contracts                                                                                                                                   |
| D3  | **No universal binding mechanism.** Per-protocol config is each handler's configuration                                                                                                                                                                                                                                                                                         | Three API iterations proved the general mechanism's constraint set pins to a single unpleasant solution; the actual protocols have different natural authoring shapes (Appendix A)                                                                                   |
| D4  | **Projections never invent names.** Every public name is the image of the native fq-name under that protocol's deterministic transform (JSON-RPC: `/` → `.`; MCP: derived tool names, casing per transform; gRPC later: path → package/Service + Method). No `rename` config anywhere. Selection (`include`/`exclude`, curation) stays per-handler and operates on native names | Zero authoring, zero runtime name tables (transform + existing flat-map lookup), reversible in both directions, one name to grep across logs/metrics/docs. Type-only clients stay possible for every protocol via one frozen template-literal transform per protocol |
| D5  | **MCP is a curated handler-level map** — curation and `description` are the authored content; tool names are derived by default (D4), map keyed off the procedure reference                                                                                                                                                                                                     | MCP surfaces are small and curated — the map _is_ the curation; descriptions must be authored regardless; names never were the creative part. Value references give kind/type checking and schema derivation                                                         |
| D5a | **Segment charset constraint at registration**: route/procedure keys restricted (e.g. `[a-zA-Z0-9-]+` — no `/`, `.`, `_`, spaces); violation throws in the registration walk                                                                                                                                                                                                    | Makes every present and future separator transform bijective and collision-free by construction (a dot in a segment would make the JSON-RPC transform ambiguous; underscores would collide under MCP's)                                                              |
| D6  | **Multi-mount stays legal**; value references (MCP) resolve to a tree position at construction, with an explicit fq-name disambiguator (`at:`) required when a procedure is mounted more than once                                                                                                                                                                              | Same procedure under different routers with different guard/meta/middleware chains is a legitimate pattern; structural protocols (native, JSON-RPC) are position-keyed and never ambiguous                                                                           |
| D7  | **HTTP-native interfaces are abandoned, not deferred.** External HTTP frameworks consume the container (Slice E)                                                                                                                                                                                                                                                                | HTTP's resource semantics never fit the RPC shape; the container was always the real integration surface. Strongest form of the original proposal's §17                                                                                                              |
| D8  | The **contract stays the native projection** and canonical identity; nothing protocol-specific enters it                                                                                                                                                                                                                                                                        | Standard protocols are consumed by standard clients; the contract's naming machinery and both first-party clients stay structurally intact                                                                                                                           |
| D9  | All handler-level config is **validated at construction, host-free** (unknown fq-names in include/rename, kind violations, blob-bearing schemas on non-native projections)                                                                                                                                                                                                      | Invariant: applications validate and are testable with no socket anywhere                                                                                                                                                                                            |
| D10 | The **reuse unit for external apps is the procedure/stream value**, not the bare handler                                                                                                                                                                                                                                                                                        | The procedure carries the contract — input validation, typed output, attached policy. Bare handlers cross boundaries unvalidated; workflows get away with it only because they add their own contract layer                                                          |
| D11 | Pubsub `SubscriptionContract`/`EventContract` are **out of scope**                                                                                                                                                                                                                                                                                                              | Broker-channel descriptions (namespace/params/key/events), not routes; no collision once the kind is named `stream`                                                                                                                                                  |
| D12 | JSON Schema emission from `@nmtjs/type` is a **prerequisite for MCP**                                                                                                                                                                                                                                                                                                           | MCP tool inputs require JSON Schema; zod-codec base (5e340830) should make this a wrapper plus custom-type handlers                                                                                                                                                  |

## Dependency graph

    A (route kinds) ──→ B (JSON-RPC)
    C (JSON Schema emission) ──→ D (MCP)   (B's patterns also inform D)
    E (standalone consumption) — independent of B/C/D
    F (wire-naming cleanup) — independent; fold into A or land anytime

Each slice is a `dev/*` branch that lands green on its own. Clean cuts, no
compatibility aliases; no slice contains an unresolved design debate.

---

## Slice A — Route kinds: `procedure` + `stream`

Branch: `dev/route-kinds` · Packages: contract, application, client, gateway (touch)

- **contract**: split `TProcedureContract` into two kinds — `neemata:procedure` (drop
  the `stream` field) and new `neemata:stream` (same input/output/name/timeout shape).
  New `c.stream()` beside `c.procedure()` (contract/src/schemas/procedure.ts). Delete
  the dormant `TRouterContract.default` field (router.ts:28-33). Name-rewriting
  machinery (`concatFullName`, router.ts:89-114) untouched.
- **application**: new `stream()` factory beside `procedure()` in api/procedure.ts;
  `streamTimeout` moves there. `implement()` handles both kinds. `ApplicationApi`
  branches on contract kind instead of `contract.stream` (api.ts:410-449, 118-143).
- **Descriptions**: contractless `procedure()`/`stream()` accept optional
  `title`/`description`, threaded into the synthesized contract (contracts already
  support `ContractSchemaOptions` — utils.ts:1; contract-first procedures carry them
  there). Used later for API documentation; MCP tool descriptions default from the
  contract description (entry-level override wins).
- **client**: `RuntimeClient` splits call/stream surfaces by kind
  (clients/runtime.ts:70-113); `StaticClient`/`ClientCallers` typing keys on kind
  (client/src/types.ts:93-176). No wire changes — the protocol never carried the flag.
- **Segment charset constraint (D5a)**: registration walk rejects route/procedure
  keys outside the allowed charset — lands here since this slice touches the
  contract/registration layer anyway.
- **Breaking**: `procedure({ stream: true })` is gone; migration is mechanical.
  Charset restriction may break exotic route keys (also mechanical).
- **Exit**: suite green; `use-neemata` skill docs updated; type-level test asserting a
  stream route is unassignable where a procedure kind is required; registration test
  for charset violations.

## Slice B — JSON-RPC handler

Branch: `dev/json-rpc` · Packages: transports (new `./json-rpc` subpath, per the #314
consolidation), json-format

Structural projection of the router — no new application-layer concepts:

    // factory named like the existing ServerHandler factories (neemataHttp,
    // neemataWebSocket) — "handler" is already overloaded (procedure handler,
    // core createHandler, ServerHandler) and gains no fourth meaning
    jsonRpc({
      path: '/rpc',
      maxBatchSize: 100,                        // default
      // optional selection, validated at construction against the flat procedure map:
      include: ['users/*', 'billing/*'],        // default: all unary procedures
      exclude: ['internal/*'],
    })

- **Naming (D4)**: fq-name with `/` → `.`, no name table at runtime — incoming
  method → split on `.`, join with `/`, look up in the existing flat map
  (runtime.ts:214). No `rename`. Type-level counterpart is one template-literal
  transform, so a future type-only JSON-RPC static client derives from `typeof root`.
- **Exposure**: all unary procedures by default (consistent with native); `stream`
  routes excluded by kind automatically. Blob-bearing schemas are auto-excluded from
  expose-all and a construction error if matched by an explicit `include`.
- **Protocol**: JSON-RPC 2.0 — single calls, batches (`maxBatchSize` default 100),
  notifications (execute through the full pipeline, discard response), spec error
  objects with an `ApiError → code` mapping table, parse/invalid-request errors.
  Transient connection per request (mirror http/server.ts); one Call scope per method
  in a batch; batch execution order: bounded-concurrency parallel (spec permits any).
- **Pipeline**: enters via the existing `GatewayApi` seam (`resolve`/`call`,
  gateway/src/api.ts:37-42) — position-keyed, so router/app-level guards, middleware,
  meta, and filters apply identically to native calls.
- Exit: JSON-RPC 2.0 spec-case conformance tests; a stock third-party JSON-RPC client
  works unmodified; include/exclude/rename validation errors fire at construction.

## Slice C — JSON Schema emission from `@nmtjs/type`

Branch: `dev/type-json-schema` · Parallel to A/B

- `t.toJSONSchema(type)`: wrapper over zod's native emission plus handlers for Neemata
  custom types; `blobType` → deliberate error or opaque marker. Documented
  unsupported-type policy.
- Exit: every schema in the workspace's own tests emits valid JSON Schema or a
  deliberate error. Gates Slice D.

## Slice D — MCP handler

Branch: `dev/mcp` · Depends on B (patterns) + C (schemas) · Packages: transports
`./mcp` subpath **or** separate `@nmtjs/mcp` (decided by the SDK spike)

**Tools API shape approved in general nature, details provisional** — the final MCP
API (entry config, possible exposure constraints, resolution rules) is decided after
Slice B ships, informed by its patterns.

    mcp({
      path: '/mcp',
      tools: [
        {
          procedure: createUser,                 // value reference — typed
          description: 'Create a user account',  // defaults from contract description;
                                                 // required if the contract has none
          // name derived per D4 (e.g. users_create); casing is part of the transform
          // at: 'admin/users/create',           // only if createUser is multi-mounted
        },
      ],
    })

- Procedure kind only (type-level); no blobs (construction check); input schemas via
  Slice C. Value references resolve to a tree position at construction; multi-mount
  without `at:` is a construction error (D6).
- Streamable-HTTP MCP server: `initialize`, `tools/list` from the map, `tools/call` →
  gateway call with the full position-aware pipeline. MCP session-id maps to a Neemata
  connection, so connection-scoped DI works per agent session.
- Decision first: half-day spike — `@modelcontextprotocol/sdk` vs implementing the
  (small) server side of streamable HTTP natively over the fetch-handler mount. A
  heavy dep argues for a separate package.
- Exit: MCP inspector / Claude Code lists and calls tools end-to-end; distinct
  sessions get distinct connection scopes.

## Slice E — Standalone consumption (external HTTP apps and beyond)

Branch: `dev/standalone-runtime` · Packages: core (exposure), application, nmtjs
umbrella · **API shape provisional — direction approved, surface may be revised**

The replacement for HTTP-native interfaces: first-class consumption of the container
and procedures from outside Neemata's transports. `Container` and
`ExecutionEnvironment` (core/src/container.ts:73, execution-environment.ts) already
have no dependency on gateway/application — this slice is mostly exposure plus
ergonomics.

The consumption ladder:

1. **Injectables** — `scope.resolve(service)`; logic that was never an operation.
2. **Procedure/stream values** — the primary unit (D10): `scope.call(createUser,
input)` runs the position-free pipeline — input decode (ValidationError on bad
   input) → procedure-attached guards → procedure-attached middlewares → DI context →
   handler — and returns typed runtime output (caller serializes). `scope.call` on a
   `stream` returns the `AsyncIterable` (maps to SSE/chunked/WS in the host
   framework).
3. **`application.invoke(fqName, input, ctx)`** — position-aware: the full chain
   including router/app-level guards, middleware, and filters. Doubles as the
   no-network testing API.

Pieces to build:

- `createStandaloneRuntime(environment)` — initialize/dispose an
  `ExecutionEnvironment` (plugins, lifecycle hooks, global scope) with no gateway,
  transports, or router. Extracted from what `NeemataApplication`/`ApplicationHost`
  already do minus networking.
- `runtime.callScope({ provide? })` — per-request fork returning an `await
using`-disposable scope (disposal pattern precedent: gateway.ts:379-391). `provide`
  lets glue code satisfy guard dependencies (e.g. an auth context) from the host
  framework's own middleware.
- **Guard-dependency rule**: procedure-attached guards run, always — there is no
  skip-guards flag. A guard depending on gateway-provided injectables makes the
  procedure non-portable; that must fail loudly at resolution time, naming the
  missing injectable.
- Open design items (the "provisional" part): whether Call scope forks directly from
  Global or a standalone runtime holds one ambient Connection scope
  (Connection-per-socket if the host app has its own WebSockets); the exact
  `scope.call` output contract (decoded output vs optional wire encoding); the
  `invoke` context parameter shape.
- **Documentation, not adapter packages**: the per-framework glue (Hono/Fastify/
  Elysia middleware opening/disposing a scope) is ~10 lines; document the pattern.
  No `@nmtjs/hono` unless real demand appears.
- Deployment: the HTTP app runs as a sibling runtime supervised by Neem — the
  pattern the `@nmtjs/vite` / `@nmtjs/nuxt` presets established — in-process with the
  container, or as a separate process using an ordinary Neemata client.

Exit: an example Hono app exercising all three ladder rungs (service, procedure,
stream-to-SSE, invoke) with lifecycle start/stop under Neem; resolution-time error
message test for a non-portable guard; `application.invoke` used by at least one of
the workspace's own test suites in place of a transport.

## Slice F — Wire-naming cleanup

Fold into A or land independently. Source-level renames only (enum values unchanged,
not wire-breaking): `ClientStream*`/`ServerStream*` wire message names → `Blob*` to
match the API surface (`ProtocolBlob`, `createBlob`/`consumeBlob`); delete the
commented-out `// Event = 1` remnant (protocol/src/common/enums.ts:22). Resolve or
ticket the documented WS/HTTP blob-injectable divergence (gateway.ts:805-818).

---

## Deferred / out of scope

- **gRPC** — re-evaluation gate after D ships; maps naturally to the RPC kernel
  (proto-first service definitions → procedures) but carries the proto-compat problem
  and a dedicated HTTP/2 host.
- **client-stream / bidirectional kinds** — reserved names, no implementation; gRPC
  is their only consumer.
- **`subscription` route kind** — future; would build on the untouched pubsub channel
  contracts.
- **Typed static clients for JSON-RPC** — possible type-only from `typeof root` (D4's
  structural naming); build when wanted, no codegen required.
- **OpenAPI emission** — no longer applicable to Neemata itself (HTTP abandoned);
  the external HTTP framework owns its own API description.
- **Adapter packages** (`@nmtjs/hono` etc.) — documented patterns first; packages
  only on demonstrated demand.
- The existing native `neemataHttp` transport **stays as-is** — it is the native
  protocol over HTTP for `@nmtjs/http-client`, not an HTTP-native interface.

## Invariants (updated)

Kept from the original proposal: one external invocation ↔ one procedure; all
projections reuse the same execution pipeline; hosts own listeners; handlers never
close a shared host; applications run and validate without a network host (now
load-bearing twice: D9 construction-time validation, Slice E's `invoke` as the
testing API); first-party projections independently packageable.

Amended: "interfaces select and name public operations" → each **handler's
configuration** selects and names, in the shape natural to its protocol; "interface
metadata does not pollute operation definitions" → satisfied by construction
(procedures and routers carry no protocol metadata at all); "unsupported combinations
fail during configuration or type-checking" → kind checks at the type level where
config references values (MCP), construction-time validation everywhere.

New: **the tree owns semantics, projections own selection** — everything behavioral
(guards, middleware, meta, timeouts, DI scoping) lives at a tree position and is
inherited hierarchically; a projection contributes only selection. **Projections
never invent names** (D4): every public name is a deterministic transform of the
native fq-name, made bijective by the segment charset constraint (D5a).

---

## Appendix A — The binding mechanism: considered and rejected

v1 of this plan (and two subsequent iterations) attempted a universal, per-route,
statically-typed binding mechanism. The arc is preserved because the constraint map
is the reusable artifact: anyone reattempting cross-protocol per-route naming should
start here.

**Accumulated constraints** (each discovered by an iteration failing without it):

1. Procedure definitions stay protocol-free.
2. The public surface must be derivable from types alone (the `StaticClient`
   property: type-only import, zero runtime).
3. Public names must be explicit literals — fq-derived names are unknowable at the
   authoring site (a router doesn't know its mount position) and would silently
   change on restructure; deriving them also duplicates naming logic in type-land
   and runtime.
4. The route structure must be declared once — no re-listing routes per protocol.
5. Bindings must anchor to tree **positions**, not procedure identities — the same
   procedure legitimately mounts under multiple routers with different policy chains.
6. Hierarchical policy, host-free validation, third-party extensibility.

**Iteration 1 — fluent `.bind(token, map)` on the router**: right anchor (position),
wrong adjacency — a parallel map mirroring route keys, `const`-type-parameter capture
with widening caveats, token cardinality flags, a tree-walk collection API, and a
special doctrine (v1's D13) to protect constraint 2. Machinery existed to reassemble
a flat table that was never allowed to exist as an object.

**Iteration 2 — authored surface maps** (`jsonRpc.surface({ 'users.create':
createUser })`): every constraint 1–3 satisfied _by construction_ (object keys are
literal types; kind checks are `Record<string, AnyProcedure>`)… and constraints 4–5
violated fatally: re-declares the route list per protocol, and value references
required a single-mount invariant that amputated multi-mount instead of supporting it.

**Iteration 3 — inline bindings at the route entry** (`route(createUser,
rpc('users.create'), …)` with token instances as surface identity): the unique point
satisfying 1–6 simultaneously — and ergonomically bad: manifest-style entries,
public-name prefix repetition scaling with tree depth, extraction-type machinery for
typed clients.

**Conclusion**: when a design space narrows to one admissible solution and that
solution is unpleasant, a requirement is wrong. The wrong requirement was the
universal mechanism itself. The protocols on the actual roadmap have different
natural authoring shapes — JSON-RPC wants structural naming (no authoring at all),
MCP wants a small curated map (authoring _is_ the curation), HTTP wanted per-route
everything — and HTTP, the one non-RPC shape, was the sole driver of the remaining
complexity. Removing HTTP (D7) dissolved the requirement; per-handler configuration
(D3) covers everything left.
