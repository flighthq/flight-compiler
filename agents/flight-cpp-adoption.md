# flight-cpp adoption handoff

The maintained downstream checklist lives in [`flight-cpp/docs/flight-compiler-adoption.md`](https://github.com/flighthq/flight-cpp/blob/main/docs/flight-compiler-adoption.md). Do not maintain a second capability checklist here. This document records the newest compiler-side reproduction and the issues that must be reconciled into that downstream register.

The compiler owns emitted names, lowering, package-graph semantics, and runtime capability declarations. flight-cpp owns runtime implementations, CMake and Bazel packaging, native dependencies, conformance tests, and release. Never work around a compiler representation defect by rewriting generated headers or weakening a runtime assertion.

## Latest reproduction

The 2026-09-15 audit used an isolated checkout and did not modify the flight-cpp source tree:

| Input           | Revision                                   |
| --------------- | ------------------------------------------ |
| flight-cpp      | `79765ddc3c4d772c5e1e601eb9e0a83f65788ef6` |
| Flight          | `1274ec5c923947dc64d5ffedcbd8169fc758cd9f` |
| flight-compiler | `ba2ff1ab8d63a2c0e02510818607c6c1bad7edf3` |

The complete SDL profile processed all 154 packages and 2,851 modules in about 208 seconds. It emitted 1,093 dependency-closed headers and recorded 1,758 deterministic refusals: 939 direct `unsupported-ir` refusals and 819 dependency-propagated refusals. No internal-error or invalid-target-name entry remains.

GCC 15.2 compiled every emitted header independently. The exact result is 1,092 passing and one failing header. The report is `out/sdk-sdl-header-compilation.json` in the isolated flight-cpp checkout and records the source/compiler revisions and compiler executable. The repeat gate confirmed that chained optional fallbacks, imported anonymous object fields, binpack structural arguments, spatial intersections, and physics ownership keys now compile.

## flight-cpp work exposed by this gate

One failed header needs an identity-preserving object-property view:

- [ ] Provide a supported way to project `flight::Ref<void>` into symbol-keyed attached storage without copying the object or its properties. `flight/particles/particle_emitter_signals.hpp` casts an arbitrary JavaScript object to `Record<symbol, ParticleEmitterSignals | undefined>` and then uses presence-bearing `get`/`set`. The view must retain one owner per native object identity, share symbol properties with every typed or structural projection of that object, distinguish a missing entry from a present `undefined` value, and keep attachments alive for the lifetime of the object rather than a transient view. A compiler-facing spelling such as an erased-object `Record` view or a `StructuralRef` dynamic-symbol view is sufficient; flight-compiler should elect the final API once it exists.
- [ ] Refresh `tests/generated/semantic_runtime.hpp` from this compiler. The current downstream fixture differs only because the compiler now emits the already-boolean `Set.has` condition directly and therefore omits the unused `flight/boolean.hpp` include. The compiler's conformance equality gate remains intentionally red until flight-cpp commits the regenerated artifact.
- [ ] Provide an erased dynamic value for the type positions TypeScript writes as `any` or `unknown` whose representation is deliberately unconstrained. **This is the single largest lever in the corpus and it cannot be taken from the compiler side.** The C++ emitter has no spelling for them, so it reaches its unresolved-placeholder guard and refuses the module. The compiler side was checked and is closed: `flight-cpp` has no suitable type — the only variants in the runtime today are `PropertyKey = std::variant<String, double, Symbol>` and `Presence<Value> = std::variant<Undefined, Null, Value>` — and `source: 'object'` is already decided as `flight::Ref<void>`; the rest are opaque host handles that are not necessarily objects — `AnimationChannel.targetRef` is documented as never interpreted, and `NativeWindowHandle` is documented as deliberately unnarrowed — so `Ref<void>` would misrepresent a value that is a number. The value must keep a missing entry distinct from a present entry whose value is absent. Ranked effect: the top blockers are `types/AnimationChannel.ts` (99 dependents), `types/Node.ts` (76, as `Node<any>`), `types/ApplicationWindow.ts` (49), `types/GlContext.ts` (25) and `types/NodeInteractiveStateBinding.ts` (17); 69 modules refuse directly and 320 through their dependents, which is the whole of the corpus's largest family. A rough half of the 1108 → 1500 step lives here. This is the same class of decision as the object-property view above, and the compiler elects the spelling once it exists.
- [ ] A generic `Omit<Row, 'key'>` has no C++ spelling: `structural_ref.hpp` supplies `RowOf`, `RowMerge`, `RowPartial`, `RowReadonly`, and `RowWritable` but nothing that subtracts a key. Written concretely, `Omit<Row, 'key'>` already materialises a nominal row at its use site, so this is not blocking anything today and needs no work on its own account — an earlier draft of this register asked for a projection primitive on the assumption that it did, and that ask was withdrawn. It stays listed only because `@flighthq/types`'s `PartialNode<T>` is `{ … } & Partial<Omit<T, 'data'>>` and the generic form of that alias, which blocks `@flighthq/node` and up to 446 modules behind it, has to land on something. `PartialNode<T>` is a bag of the node's named properties with every member optional, so `RowPartial<RowOf<T>>` already carries all of it: the compiler has elected that shape, with `data`'s narrowing carried by the cast its consumers already write. Nothing here is needed to land it. See [the coverage plan](flight-cpp-coverage-plan.md), Stage 1.

- [ ] Declare and implement `CanvasRenderingContext2D`. It is 53 of the 110 direct refusals in the runtime-external-symbol family — the single largest missing symbol, and the cheapest large win available anywhere in the corpus. Both halves are missing and both are needed: `bindings/web-types.json` declares `CanvasRenderingContext2DSettings` but not the context type itself, and `flight/web_types.hpp` has six declarations and does not define it either. A profile entry alone would bind to a type that does not exist.
- [ ] Provide per-arm settled-task result types. `Promise.allSettled` reaches `PromiseFulfilledResult` and `PromiseRejectedResult`, and the runtime has only the union of the two: `flight::TaskSettlement<Value>` carries `status`, `value` and `rejection` together. Binding either arm to it would misstate the arm — a fulfilled result has no rejection and a rejected result has no value — and the binding contract requires a single `targetName`, so the compiler cannot spell the arms structurally through it either. Two modules today, so rank it below the two above; it is listed because the shape of the gap matters if `allSettled` spreads.

The structured conformance exception ledger is current and passes `npm run cpp:exceptions:check` with its one compiler-analysis refusal.

Move the compiler/runtime pins together when the object-property spelling lands. It needs installed CMake and Bazel exposure, an emitted-header compile check, and a TypeScript-versus-native behavioral oracle proving repeated enable/get calls observe the same attached signal group. ABI 1 was never released, so the first released ABI number must also advance coherently rather than treating the present assertion as published history.

The CMake and Bazel repository-wide checks recorded in downstream documentation were not rerun for `79765dd`; this audit covers complete SDK generation and the independent-header compilation surface. The generated SDK must remain a preview until its full dependency closure compiles.

## Compiler-owned tail

A fresh SDL-profile run at compiler `9cc35da` emits 1,106 of the 2,851 source modules. The abandoned 2026-09-15 figures above describe a compiler revision 153 commits behind; the staged order of attack over the current ranking lives in [`flight-cpp-coverage-plan.md`](flight-cpp-coverage-plan.md), which also records how to regenerate the ledger. In short: a conditional type whose only inhabited branch is an `infer` variable and a generic alias body that resolves only at instantiation block `PartialNode` and, through it, the node and scene-graph foundation; an erased dynamic value blocks every deliberately unconstrained `any`/`unknown` type position; contextual union and optional construction evidence, `typeOf` computation, and the structured-refusal long tail follow. Host-manifest absences remain explicit configuration work; do not replace them with a blanket opaque or dynamic fallback.

## Reproduction

From a flight-cpp checkout whose `.dependencies/flight-compiler` resolves to the compiler revision above and whose Flight lock resolves to the source revision above, run the downstream scripts named `sdk:generate:sdl` and `sdk:compile:sdl`; for example:

```sh
npm --prefix /path/to/flight-cpp run sdk:generate:sdl
FLIGHT_CPP_COMPILE_JOBS=12 npm --prefix /path/to/flight-cpp run sdk:compile:sdl
```

The generation command must complete the entire graph and write deterministic manifest/refusal output. The compile command is expected to remain nonzero until the erased-object symbol-property view above is implemented and elected by the compiler; its JSON report, rather than the first diagnostic, is the production-readiness evidence.
