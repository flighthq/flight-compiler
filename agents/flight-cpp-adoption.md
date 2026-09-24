# flight-cpp adoption handoff

The maintained downstream checklist lives in [`flight-cpp/docs/flight-compiler-adoption.md`](https://github.com/flighthq/flight-cpp/blob/main/docs/flight-compiler-adoption.md). Do not maintain a second capability checklist here. This document records the newest compiler-side reproduction and the issues that must be reconciled into that downstream register.

The compiler owns emitted names, lowering, package-graph semantics, and runtime capability declarations. flight-cpp owns runtime implementations, CMake and Bazel packaging, native dependencies, conformance tests, and release. Never work around a compiler representation defect by rewriting generated headers or weakening a runtime assertion.

## Latest reproduction

The 2026-09-15 audit used an isolated checkout and did not modify the flight-cpp source tree:

| Input           | Revision                                   |
| --------------- | ------------------------------------------ |
| flight-cpp      | `978e02851325dd1e0e0d07665546b6b69a19e28b` |
| Flight          | `1274ec5c923947dc64d5ffedcbd8169fc758cd9f` |
| flight-compiler | `85a6576acd38025769c1be0a773d608f4e04b1b2` |

The complete SDL profile processed all 154 packages and 2,851 modules in about 208 seconds. It emitted 1,093 dependency-closed headers and recorded 1,758 deterministic refusals: 939 direct `unsupported-ir` refusals and 819 dependency-propagated refusals. No internal-error or invalid-target-name entry remains.

GCC 15.2 compiled every emitted header independently. The exact result is 1,092 passing and one failing header. The report is `out/sdk-sdl-header-compilation.json` in the isolated flight-cpp checkout and records the source/compiler revisions and compiler executable. The repeat gate confirmed that chained optional fallbacks, imported anonymous object fields, binpack structural arguments, spatial intersections, and physics ownership keys now compile.

## flight-cpp work exposed by this gate

**All four asks this register carried are implemented downstream at `978e028`.** What follows is what each one now is and what it measured here, so the entries are not re-filed.

- [x] The symbol-keyed attached storage is `flight::AttachedProperties` with `flight::attached_properties(ref)`. **No compiler change is needed**: the spelling this compiler already emits for `particle_emitter_signals.hpp` — an erased `Ref<void>` cast to a presence-bearing `Record<Symbol, …>` with `get`/`set` — projects the object's attached properties and shares one store with a row's computed-symbol accessors. Two defects were fixed on the way: the owner registry was keyed per object _type_, so a typed projection and an erased one resolved different stores, and it held owners weakly, so attachments died with the view rather than the object.
- [x] The erased dynamic value is `flight::Any` (`flight/any.hpp`), a closed variant over every language type the runtime has. It cannot be elected from a binding profile, so this compiler elects it in `emitTypeCpp`'s `unknown` arm, after the `this` and `object` cases. **Measured here: the auto-placeholder family falls from 69 direct modules to zero, and the corpus goes from 1,108 to 1,339 emitted of 2,851.** Coverage unchanged for everything else, which is why it is the largest single step taken so far. One gap the election exposes rather than causes: a callable whose result type is not bound — `Symbol.for` and `new Symbol` are the two in evidence — now erases to `Any` where the old `auto` deduced the concrete type from the initializer. That is sound but less precise; giving a _member_ binding a call-result type is not expressible in `CompilerRuntimeExternalMemberBinding` today, which carries only `sourceMember` and `targetName`.
- [x] `CanvasRenderingContext2D`, `CanvasGradient`, `CanvasPattern` and `DOMMatrix` are implemented in `flight/canvas_2d.hpp` and elected by `bindings/web-types.json`. The drawing-state stack, transforms, path construction, dash lists, gradient stops and pattern parameters are runtime-owned; pixels are delegated to a host-supplied rasterizer, and a context created without one reports `isContextLost()` rather than pretending.
- [x] `structuredClone` is `flight/structured_clone.hpp`, elected in `bindings/runtime.json`. A type with no clone definition is a compile-time refusal naming `structured_clone_traits` rather than a shallow copy wearing a deep copy's name.
- [x] Per-arm settled results are `flight::TaskFulfillment<T>` and `flight::TaskRejectionResult`, elected as `PromiseFulfilledResult` and `PromiseRejectedResult`. Together with the two above, the runtime-external-symbol family falls from 110 direct refusals to 46 on this profile.

**The unresolved-placeholder guard is now unreachable, and that is recorded rather than discovered later.** With `any` and `unknown` elected, nothing in the 2,851-module corpus reaches it: the family is zero. `flight-cpp`'s own record expects alias residue to still reach it as `auto`, but residue is produced as `IrType { kind: 'unknown', source: 'unknown' }`, which is one of the two sources the election names, so residue is elected too. Either the election should spare residue or the guard should go; leaving both in place means a guard no test can reach.

- [ ] **A typed-array element write needs a converting write spelling.** `flight::TypedArray::element(double)` returns a raw `Value&`, so the generated `values.element(0.0) = 300.0;` assigns a `double` straight into element storage. For a value outside the element's range that is undefined behaviour rather than a wrap, and the two compiler families disagree exactly as UB permits: GCC and Clang wrap (`300 -> 44`, `-1 -> 255`) and MSVC saturates (`300 -> 255`, `-1 -> 0`). The `typedArraySemantics` oracle's second answer is that divergence — expected `[44,255,2,1,58]`, MSVC produced `[255,0,2,1,58]` — so the compiler's typed-array element writes are correct today only where the language's UB happens to agree with ECMAScript.

  The runtime already owns the right conversion: `TypedArray::convert_element<Source>` applies the ECMAScript rules, clamps for `Uint8Clamped`, and maps NaN and infinities the way the language does. It is `private` and reachable only from the constructors and the iterator copy, so nothing the compiler emits can use it. The ask is one public spelling for an indexed write — `void set_element(double index, Source&& value)` storing `convert_element(std::forward<Source>(value))`, or `convert_element` made public, or `element(double)` returning a proxy whose `operator=` converts. Any of the three keeps the emitted `values.element(0.0) = 300.0` shape working while the conversion stops being the language's undefined behaviour. Semantics requested: the same conversion a construction applies, so a write and a construction agree for every element type; one conversion per write; no clamping on the integral types that do not clamp. The Rust target already writes elements through a runtime call (`set_index`) rather than a raw reference, which is why only C++ diverges.

  Once that spelling exists, this compiler emits it for all three write shapes it produces for a typed-array element — the plain assignment, the compound assignment, and the modulo form it lowers through an assignment reference — and the existing goldens are regenerated by `npm run golden`. No compiler change is possible before then without duplicating the conversion rules in generated source, which is why this is filed rather than patched. Measured while filing it: the pinned `018fa444` and upstream `340427e9` are byte-identical for `typed_array.hpp`, so this is not an upstream fix waiting on a pin bump.

- [ ] Refresh `tests/generated/semantic_runtime.hpp` from this compiler. The current downstream fixture differs only because the compiler now emits the already-boolean `Set.has` condition directly and therefore omits the unused `flight/boolean.hpp` include. The compiler's conformance equality gate remains intentionally red until flight-cpp commits the regenerated artifact.
- [ ] A generic `Omit<Row, 'key'>` has no C++ spelling: `structural_ref.hpp` supplies `RowOf`, `RowMerge`, `RowPartial`, `RowReadonly`, and `RowWritable` but nothing that subtracts a key. Written concretely, `Omit<Row, 'key'>` already materialises a nominal row at its use site, so this is not blocking anything today and needs no work on its own account — an earlier draft of this register asked for a projection primitive on the assumption that it did, and that ask was withdrawn. It stays listed only because `@flighthq/types`'s `PartialNode<T>` is `{ … } & Partial<Omit<T, 'data'>>` and the generic form of that alias, which blocks `@flighthq/node` and up to 446 modules behind it, has to land on something. `PartialNode<T>` is a bag of the node's named properties with every member optional, so `RowPartial<RowOf<T>>` already carries all of it: the compiler has elected that shape, with `data`'s narrowing carried by the cast its consumers already write. Nothing here is needed to land it. See [the coverage plan](flight-cpp-coverage-plan.md), Stage 1.

The structured conformance exception ledger is current and passes `npm run cpp:exceptions:check` with its one compiler-analysis refusal.

Move the compiler/runtime pins together when the object-property spelling lands. It needs installed CMake and Bazel exposure, an emitted-header compile check, and a TypeScript-versus-native behavioral oracle proving repeated enable/get calls observe the same attached signal group. ABI 1 was never released, so the first released ABI number must also advance coherently rather than treating the present assertion as published history.

The CMake and Bazel repository-wide checks recorded in downstream documentation were not rerun for `79765dd`; this audit covers complete SDK generation and the independent-header compilation surface. The generated SDK must remain a preview until its full dependency closure compiles.

## Compiler-owned tail

A fresh SDL-profile run at compiler `04b4fd35` emits 1,339 of the 2,851 source modules, up from 1,108 at the start of this round. The abandoned 2026-09-15 figures above describe a compiler revision 153 commits behind; the staged order of attack over the current ranking lives in [`flight-cpp-coverage-plan.md`](flight-cpp-coverage-plan.md), which also records how to regenerate the ledger. In short: the erased dynamic value is elected and its family is closed; the helper families that blocked the node and scene-graph foundation are closed; contextual union and optional construction evidence, `typeOf` computation, and the structured-refusal long tail follow. Host-manifest absences remain explicit configuration work; do not replace them with a blanket opaque or dynamic fallback.

## Reproduction

From a flight-cpp checkout whose `.dependencies/flight-compiler` resolves to the compiler revision above and whose Flight lock resolves to the source revision above, run the downstream scripts named `sdk:generate:sdl` and `sdk:compile:sdl`; for example:

```sh
npm --prefix /path/to/flight-cpp run sdk:generate:sdl
FLIGHT_CPP_COMPILE_JOBS=12 npm --prefix /path/to/flight-cpp run sdk:compile:sdl
```

The generation command must complete the entire graph and write deterministic manifest/refusal output. The compile command is expected to remain nonzero until the erased-object symbol-property view above is implemented and elected by the compiler; its JSON report, rather than the first diagnostic, is the production-readiness evidence.
