# Flight → C++ coverage plan

Bring the C++ target from the current share of the Flight SDK to zero refusals with compiling, behaviourally correct output. [`flight-cpp-adoption.md`](flight-cpp-adoption.md) is the register of work that must land downstream in `flight-cpp`; this document is the staged order of attack and the evidence it is derived from.

The measure of progress is the SDK corpus ledger, not `npm run readiness`. The golden corpus is a set of probes for behaviour the compiler already has, so it reports ~99% while most of the SDK refuses; `npm run readiness:corpus` reads the ledger a downstream run leaves behind and ranks refusal families by the modules they block directly and transitively.

## Where the number stands

| Ledger                                         | Compiler  | Emitted     | Direct | Propagated |
| ---------------------------------------------- | --------- | ----------- | ------ | ---------- |
| Fresh SDL-profile run (this plan)              | `9cc35da` | 1106 / 2851 | 651    | 1094       |
| Committed `.dependencies/flight-cpp/generated` | `9f6ce1c` | 950 / 2851  | 1105   | 796        |

The committed ledger was produced 153 commits behind this tree, so it is not attributable to current work and must not be read as a delta. Regenerate before reading any number as this repository's.

Inputs: Flight SDK `1274ec5c923947dc64d5ffedcbd8169fc758cd9f` (@flighthq/sdk 0.5.0), 154 packages, 2851 modules, the seven SDL binding profiles.

## Reproducing the ledger locally

The corpus cannot be generated from inside this repository — the request needs a target repository's package graph, package targets, and binding profiles. It can still be generated on a machine with a Flight checkout, and doing so is the first step of every stage below.

1. Fetch the pinned Flight SDK outside this repository and check it out (nothing from it is committed).
2. Copy `flight-cpp` to a scratch directory and point its `.dependencies/flight` at that checkout and `.dependencies/flight-compiler` at this working tree.
3. Re-pin the copied `dependencies.lock.json` to this checkout's `HEAD`, because rehydration gates require each dependency to be clean and at the pinned revision.
4. Run the copied `sdk:generate:sdl` script with `--output=<scratch>/out/sdk-sdl`.
5. `npm run readiness:corpus -- --corpus=<scratch>/out/sdk-sdl`.

Step 4 rebuilds this repository and takes roughly three and a half minutes for the full 2851-module graph.

Two properties of the ledger decide how it is read:

- **A refused module records only its first failure.** A module blocked by a family may hold further refusals behind it, so every count below is a lower bound on that family's true reach, and each stage must be re-measured rather than extrapolated.
- **`dependency-refused` entries name the edge, not the module.** The blocked-dependents column is a dependency-closure estimate and is directional, not exact.

## Ranked blockers

Direct refusals are modules the compiler refused on their own contents; blocked is the dependency closure behind them — the modules that would become reachable if that family were resolved.

| direct | blocked | family                                                                        |
| ------ | ------- | ----------------------------------------------------------------------------- |
| 18     | 446     | `unsupported type ConditionalType`                                            |
| 56     | 262     | `flight-cpp type position retains unresolved auto placeholder`                |
| 8      | 117     | the same placeholder, reached through `Node<auto>`                            |
| 83     | 158     | `runtime external symbol binding plan is incomplete`                          |
| 118    | 156     | `contextual C++ union conversion requires equivalent source union evidence`   |
| 61     | 94      | `contextual optionalSingle construction requires expression type evidence`    |
| 30     | 51      | `type assertion target must identify exactly one C++ variant alternative`     |
| 5      | 40      | `contextual union value type flight::Map is not a represented runtime domain` |
| 34     | 34      | `anonymous object property <property> requires concrete C++ type evidence`    |
| 18     | 25      | `typeof requires closed runtime type evidence`                                |
| 19     | 23      | `typeOf types require C++ type computation lowering`                          |

The single most blocking module in the corpus is `@flighthq/types/packages/types/src/AnimationChannel.ts` at 99 blocked dependents, followed by `@flighthq/types/packages/types/src/Node.ts` at 76 and `@flighthq/types/packages/types/src/ApplicationWindow.ts` at 49. `@flighthq/types` alone carries 56 of the 651 direct refusals and 252 refused modules.

## Stage 1 — the `PartialNode` helper (18 direct, up to 446 blocked)

Seventeen of the eighteen `ConditionalType` refusals are one root cause. Every one of those seventeen modules imports `PartialNode` from `@flighthq/types`:

```ts
export type PartialNode<T> = {
  data?: Partial<T extends { data: infer U } ? U : never>;
} & Partial<Omit<T, 'data'>>;
```

The set is exactly `@flighthq/node` (node), `@flighthq/scene2d` (displayObject, displayContainer, htmlView, scale9Sprite, sprite), `@flighthq/shape` (shape, morphShape, scale9Shape), `@flighthq/text` (nativeText, richText, textLabel), `@flighthq/tilemap`, `@flighthq/movieclip`, `@flighthq/particleemitter` (particleEmitter, particleEmitter3D), and `@flighthq/quadbatch` — the display and node foundation the rest of the scene graph sits on. The eighteenth module is `@flighthq/interaction/interactionManager.ts`, which declares its own distributive conditional over signal-name literals.

### What the helper actually is

`PartialNode<T>` is a bag of the node's own named properties with every member optional — "any named property of a node, without requiring the whole thing", which is how call sites use it: `createNode3D(source.kind, { alpha, enabled, name, visible })` and `createNode3D(node.kind, { name: node.name })` pass arbitrary subsets. Checking the alias against the TypeScript checker confirms it: for `PartialNode<Node>` the properties are `data?, enabled?, name?`, and it is assignable to `Partial<Node>` in one direction only, because `data`'s value type is `Partial<T['data']>` rather than `T['data']`. So the alias is a partial structural row over the node's row, with one member — `data`, itself a bag — narrowed to a partial of itself. `data` is not special; it is the one named property whose value happens to be another bag, which is why its consumer casts it: `createData(obj?.data as Partial<Data>)`.

This matters because **the representation already exists and the concrete form already lowers to it.** With the conditional written out concretely, this compiler emits the bag exactly as described — a nominal struct whose members are all `std::optional`, `data` among them holding a nested partial struct, passed as `StructuralRef<RowReadonly<RowOf<Bag>>>`. No new runtime primitive is needed for the concrete case, and an earlier draft of this plan asked downstream for a generic "row minus one key" projection on that assumption; that ask is withdrawn.

### The two links

The seventeen modules split by instantiation: **sixteen pass a concrete argument** (`PartialNode<Node2D>`, `PartialNode<Shape>`, `PartialNode<TextLabel>`, …) and **only `@flighthq/node` passes a generic one**, `PartialNode<Node<Traits>>`. The split decides the staging, but not the need for both — every one of those sixteen packages depends on `@flighthq/node` and imports its contract, so the generic case is load-bearing for the cascade rather than optional.

**1a — a conditional whose only inhabited branch is an `infer` variable.** `lowerTypeScriptConditionalRuntimeRepresentation` returns `undefined` as soon as `containsTypeScriptInferType` holds, so `T extends { data: infer U } ? U : never` never reaches the representation check. The false branch is `never`, which `getTypeScriptConditionalInhabitedBranches` already drops, leaving exactly one inhabited branch — so the conditional is representation-neutral by the rule the surrounding comment states, and only the binding of `U` is missing. `lowerConcreteTypeScriptConditionalTypeEvidence` already substitutes the check and extends types and already selects a branch by assignability; what it does not do is bind an `infer` parameter to the position it was inferred from, so the selected branch lowers as a free type parameter. Binding `U` to the check type's property — through the checker's property type, not a syntactic indexed access, because `Partial<X['data']>` refuses where `Partial<{ … }>` lowers — closes this link, and does so for the sixteen concrete instantiations.

**1b — a generic alias body that only resolves at instantiation.** `PartialNode<T>` is generic, and `lowerTypeScriptTypeNodeEvidence` reaches the fallback at the end of the type-reference arm, whose stated intent is to "preserve the named alias instead: targets can represent an opaque generic boundary". The fallback calls `lowerType(type, context)`, which re-opens the declaration without its instantiation and reports the helper's own syntax — the outcome the comment exists to prevent, and the reason the refusal is attributed to a consumer module. Returning the named reference with its type arguments instead is what the comment describes.

1b is the reason the concrete majority alone does not finish the stage, and it is the one place where the bag framing has to carry weight rather than the nominal struct: a C++ template alias over a free `T` can express "every member of the node's row, optional" through the existing `RowPartial<RowOf<T>>`, but not the single narrowed `data` member on top of it. That is a real decision rather than a primitive to request — either the generic alias lands on the row-partial form and the `data` narrowing is carried by the cast its consumer already writes, or generic instantiations are resolved per use site and the generic form is never emitted. Decide it against emitted C++ at `@flighthq/node`'s `createNode`, not in the abstract.

**Verification.** The three named tests go green; `npm run test` holds its pre-existing failure count; then §Reproducing the ledger, expecting the seventeen modules to emit and the dependency closure behind them to open. Read the new ledger before starting Stage 2 — the yield will be lower than 446, because each module records only its first refusal.

## Stage 2 — an erased value for `any` and `unknown` type positions (64 direct, up to 315 blocked)

`emitTypeCpp` maps `IrType { kind: 'unknown' }` to `auto` whenever `source` is neither `this` nor `object`, and the emission guard then fails the module with `cpp-unresolved-type-placeholder`. `source: 'object'` already has a decided representation, `flight::Ref<void>`. The remaining `any` and `unknown` do not, and the largest blockers in the corpus are exactly this: `AnimationChannel.targetRef: unknown` (99 blocked), `type NativeWindowHandle = unknown` (49), `GlContext.viewport` (25), and `Node<any>` as `NodeAny` (76).

These are opaque handles by intent — "the animation core never interprets `targetRef`"; "a host-defined native window identity … deliberately does not narrow the representation" — and they are not all objects. A blanket `flight::Ref<void>` would be the "blanket opaque or dynamic fallback" the adoption register forbids, and would silently misrepresent a value that is a number.

This stage is therefore downstream-led: `flight-cpp` needs a supported erased dynamic value that keeps a missing entry distinct from a present `undefined`, and this compiler elects it once it exists. Recording the gap is Stage 2's first deliverable; see [`flight-cpp-adoption.md`](flight-cpp-adoption.md).

A sub-case inside the same family is compiler-side. An unresolvable generic alias is preserved as an opaque alias with `kind: 'unknown'`, whose C++ spelling is `auto` — the diagnostic says "placeholder" but the cause is Stage 1b's fallback. Resolving 1b removes those modules from this family without any runtime work.

## Stage 3 — construction and assertion evidence (179 direct, 250 blocked)

Three families share one shape: the compiler has the contextual slot but not the evidence to fill it.

- `contextual C++ union conversion requires equivalent source union evidence` (118 direct) — the source union and the target variant do not line up.
- `contextual optionalSingle construction requires expression type evidence` (61 direct).
- `type assertion target must identify exactly one C++ variant alternative` (30 direct).

These are semantic-lowering work of the ordinary kind: extend the evidence each site collects rather than adding a fallback. Rank within the stage by re-measuring after Stage 1, because several members of this group sit behind the `types` modules Stage 1 unblocks.

## Stage 4 — host bindings (83 direct, 158 blocked)

`runtime external symbol binding plan is incomplete` names symbols the C++ binding table does not bind and no binding profile declares: `CanvasRenderingContext2D`, `AudioContext`, `FontFace`, `Geolocation`, `MediaStream`, `Locator`, the `Intl` option types. The runtime lane is proven-total, so every reachable symbol must receive exactly one decision — which is the gate working as designed, not a defect.

Most of these are `discovered-partial` host endpoints and belong in a binding profile, which is configuration rather than compiler work. Two are not: `PromiseFulfilledResult` and `PromiseRejectedResult` are ambient `Promise` types, the same lane as `Promise` itself, which the C++ table already binds as a `task` runtime capability. Those belong in the binding table beside `Promise`.

## Long tail

The remaining families each block fewer than forty modules; `npm run readiness:corpus` lists all of them by payload. Work them from the ranked list the ledger prints, not from this document.

## Invariants each stage must hold

- No approximate, opaque, or silently omitted emission. A representation the target cannot express is a structured refusal, never a fallback that looks like success.
- A stage is measured, not extrapolated: every count in this plan is a lower bound, so re-run §Reproducing the ledger before starting the next stage and re-rank from the ledger's own output.
- Compiler work stays compiler work. A `discovered-partial` host endpoint is a profile entry; a runtime lane capability is an ABI decision; neither is fixed by weakening an assertion.
- Deleting a test that encodes an intended behaviour is not a fix. The three red tests in Stage 1 are the specification.
