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
| 18     | 446     | `unsupported type ConditionalType` — cleared in Stage 1, now zero modules     |
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

### The decision, and the one site it lands at

**The chosen lowering is the row-partial form with the narrowing carried by the cast.** A generic C++ template alias can already express "every member of the node's row, optional" — this compiler emits `template <typename T> using Bag = flight::StructuralRef<flight::RowPartial<flight::RowOf<T>>>;` today for a plain `Partial<T>`. What it cannot express per-member is the single narrowed `data`. But it does not have to: the narrowing is a TypeScript convenience that makes `createData(obj?.data as Partial<Data>)` check, the cast is written at every consumer already, and the runtime behaviour is "accept any subset", which `RowPartial<RowOf<T>>` states directly. So the alias lands on the row-partial form and the cast carries the rest. One definition, no per-site special-casing, and nothing a C++ reader cannot see.

### Where the work actually lands, which is not where it looks

The seventeen modules split by instantiation — sixteen pass a concrete argument (`PartialNode<Node2D>`, `PartialNode<Shape>`, `PartialNode<TextLabel>`, …) and only `@flighthq/node` passes a generic one — but **the split does not map onto two code paths, and an infer-binding fix does not work.** That was the plan's first assumption and it is wrong; the trace below is why, and it is worth not rediscovering.

Both instantiations funnel through the **declaration-site** lowering of the alias body: `lowerTypeAlias` → `lowerType` → the intersection's object member through `lowerTypeScriptTypeProperties` → `lowerType` on the conditional. That path carries **no substitutions**, so by the time the conditional is lowered the concrete argument is gone and `Value` is a free type parameter with no constraint — `checker.getTypeOfPropertyOfType` has nothing to read, and binding the `infer` variable is not merely unimplemented but impossible there. The substitution-carrying resolver that _would_ carry it, `lowerConcreteTypeScriptConditionalTypeEvidence`, exists and is live — it is entered twice across the whole `compiler-semantic` suite — but it is not on this path, and an infer binding added to it changes nothing here. Verified by instrumenting all three: the evidence resolver is never entered for the failing shape, while `lowerType`'s conditional arm throws for it six times.

Two consequences worth carrying into the work:

- **The fix is one change, in the declaration-site path**, and it is the row-partial collapse above rather than an infer binding. It has to hold for a free `T`, because the concrete argument is already erased when it runs.
- **The consumer's error is a propagation, not a second site.** The throw happens while lowering the imported declaration and is caught by the _consumer's_ top-level statement loop, so the diagnostic names the consumer as `source` while its message names the file the syntax is in. That is also why the position was meaningless before `83a03c67`, and why the sixteen concrete modules are not currently listed as dependency-refused on `node.ts`: they record their own first failure, and the dependency edge only becomes visible once it clears.

### What landed, and what it revealed

`2ed2a2ef` takes the first half: **the consumer no longer carries the helper's refusal into its own module.** `getTypeScriptNarrowingAlternatives` resolved a named type through its declaration and lowered that declaration's body in the _declaring_ module's context with no `try`/`catch`, so an unexpandable helper threw out of the consumer's statement loop. Its sibling resolver for the same shape already caught `isUnsupportedSyntaxFailure` and kept the named type; this one now does too.

Verified against the corpus, not extrapolated. The `ConditionalType` family goes **18 direct modules to zero**, the three named tests go green, and `npm run golden:check` is unchanged at 604/604 — emitted output did not move. Total coverage is unchanged at 1106/2851, which is the point below.

- **Each module now reports its true next blocker**, which is what the family was hiding. `@flighthq/node`'s `node.ts` and `@flighthq/scene2d`'s `displayObject.ts` move to `Partial<T> requires a statically resolvable C++ object shape`, because the consumer keeps the named reference and the helper's alias behind it is still opaque. The other fifteen move straight past `PartialNode` to their real blockers — `structural-row projection requires a represented object-reference target`, `contextual optionalSingle construction requires expression type evidence`, `contextual C++ union conversion requires equivalent source union evidence`, `type assertion target must identify exactly one C++ variant alternative`. Those are Stage 3 families, and they were invisible before.
- **This is the lower-bound property working as designed.** Thirteen of the seventeen were never about `PartialNode` at all; the compiler simply stopped at their first failure. Anyone reading coverage numbers should expect the same again from every stage.

### The remainder

Two modules — `@flighthq/node`'s `node.ts` and `@flighthq/scene2d`'s `displayObject.ts` — are held by the helper alias itself, which is where the row-partial decision lands. The named reference now reaches the C++ backend intact; it refuses because the alias it names is still opaque. Making the alias lower to `RowPartial<RowOf<T>>` is the remaining change, and it is the one this plan has described from the start: it has to hold for a free `T`, because the concrete argument is erased by the time the declaration-site lowering runs.

**Verification.** The three named tests go green; `npm run test` holds its pre-existing failure count; then §Reproducing the ledger, expecting the seventeen modules to emit and the dependency closure behind them to open. Read the new ledger before starting Stage 2 — the yield will be lower than 446, because each module records only its first refusal.

## Stage 2 — an erased value for `any` and `unknown` type positions (64 direct, up to 315 blocked)

`emitTypeCpp` maps `IrType { kind: 'unknown' }` to `auto` whenever `source` is neither `this` nor `object`, and the emission guard then fails the module with `cpp-unresolved-type-placeholder`. `source: 'object'` already has a decided representation, `flight::Ref<void>`. The remaining `any` and `unknown` do not, and the largest blockers in the corpus are exactly this: `AnimationChannel.targetRef: unknown` (99 blocked), `type NativeWindowHandle = unknown` (49), `GlContext.viewport` (25), and `Node<any>` as `NodeAny` (76).

These are opaque handles by intent — "the animation core never interprets `targetRef`"; "a host-defined native window identity … deliberately does not narrow the representation" — and they are not all objects. A blanket `flight::Ref<void>` would be the "blanket opaque or dynamic fallback" the adoption register forbids, and would silently misrepresent a value that is a number.

This stage is therefore downstream-led: `flight-cpp` needs a supported erased dynamic value that keeps a missing entry distinct from a present `undefined`, and this compiler elects it once it exists. Recording the gap is Stage 2's first deliverable; see [`flight-cpp-adoption.md`](flight-cpp-adoption.md).

A sub-case inside the same family is compiler-side, and Stage 1 moved seven modules into it. An unresolvable generic alias is preserved as an opaque alias with `kind: 'unknown'`, whose C++ spelling is `auto`, so the diagnostic says "placeholder" while the cause is a helper that could not lower. Clearing Stage 1 walked those modules off `ConditionalType` and onto this rule — the family reads 64 direct modules before that change and 71 after, with total coverage unmoved. Distinguish the two before treating this family as one job: a module that refuses here because of an opaque helper is Stage 1's remainder, not a missing runtime capability.

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
