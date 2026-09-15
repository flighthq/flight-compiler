# flight-cpp adoption handoff

The maintained downstream checklist lives in [`flight-cpp/docs/flight-compiler-adoption.md`](https://github.com/flighthq/flight-cpp/blob/main/docs/flight-compiler-adoption.md). Do not maintain a second capability checklist here. This document records the newest compiler-side reproduction and the issues that must be reconciled into that downstream register.

The compiler owns emitted names, lowering, package-graph semantics, and runtime capability declarations. flight-cpp owns runtime implementations, CMake and Bazel packaging, native dependencies, conformance tests, and release. Never work around a compiler representation defect by rewriting generated headers or weakening a runtime assertion.

## Latest reproduction

The 2026-09-14 audit used an isolated checkout and did not change the materialized flight-cpp dependency in this repository:

| Input           | Revision                                   |
| --------------- | ------------------------------------------ |
| flight-cpp      | `ef60ec7d22f381cd8bc149b1040133cc1c00bcab` |
| Flight          | `1274ec5c923947dc64d5ffedcbd8169fc758cd9f` |
| flight-compiler | `ee493b3186c49831c642267ea47d7ba71f15cb2b` |

The complete SDL profile processed all 154 packages and 2,851 modules in about 160 seconds. It emitted 1,093 dependency-closed headers and recorded 1,758 deterministic refusals: 872 direct `unsupported-ir` refusals and 886 dependency-propagated refusals. No internal-error or invalid-target-name entry remains.

GCC 15.2 compiled every emitted header independently. The exact result is 1,044 passing and 49 failing headers. The report is `out/sdk-sdl-header-compilation.json` in the isolated flight-cpp checkout and records the source/compiler revisions and compiler executable. `flight/socket/explain_socket_send_failure.hpp` now compiles: contextual object construction retains literal-discriminated source alternatives after representation-equivalent union slots are grouped. `flight/audio/audio_resource.hpp` also now compiles after generic structural declarations began self-substituting their own parameters during representation planning.

## flight-cpp work exposed by this gate

Seven failed headers need three concrete runtime APIs:

- [ ] Add `flight::number_to_string(number, radix)` with ECMAScript-compatible radix behavior. Five emitted color and tilemap headers require it.
- [ ] Add `flight::String::pad_end`; `flight/font_formats/sfnt_assembly.hpp` requires it.
- [ ] Add non-global `flight::Symbol(flight::String)` construction, distinct from `Symbol::for_key`; `flight/particles/particle_emitter_signals.hpp` requires it.
- [ ] Refresh `tests/generated/semantic_runtime.hpp` from this compiler. The current downstream fixture predates declaration scheduling and expression-normalization changes, so the compiler's conformance equality gate remains intentionally red until flight-cpp commits the regenerated artifact.
- [ ] Refresh `conformance/known-exceptions.json`: `nameCollision` now emits and should be removed; the WeakMap case now refuses with `flight-cpp WeakMap key requires a proven flight reference representation`, so its expected rule and owner need to follow that narrower invariant.

Move the compiler/runtime pins together when these spellings land. Each needs installed CMake and Bazel exposure, an emitted-header compile check, and a TypeScript-versus-native behavioral oracle. ABI 1 was never released, so the first released ABI number must also advance coherently rather than treating the present assertion as published history.

The CMake and Bazel repository-wide checks recorded in downstream documentation were not rerun for `ef60ec7`; this audit covers complete SDK generation and the independent-header compilation surface. The generated SDK must remain a preview until its full dependency closure compiles.

## Compiler-owned tail

The other 42 native-header failures stay in flight-compiler:

- 16 incompatible generated structural assertions across adjustments, image-codec, and spatial;
- 19 nominal/structural/optional representation conversions across binpack, font-formats, materials, media, mesh, particles, physics3d, scene2d-formats, and skeleton2d;
- six recursive-alias declaration failures for `TiledLayer` and `FlightDocumentValue`; and
- one incorrectly optionalized XML replacement-callback parameter.

The largest direct refusal families are missing equivalent source-union evidence (187), asserted alternatives that do not select one C++ variant arm (80), the intentionally manifest-owned `CanvasRenderingContext2D` binding (54), anonymous pipeline properties without concrete type evidence (34), and unresolved `typeOf` computation (32). Work these down by dependency-closure impact and compile each newly admitted header. Host-manifest absences remain explicit configuration work; do not replace them with a blanket opaque or dynamic fallback.

## Reproduction

From a flight-cpp checkout whose `.dependencies/flight-compiler` resolves to the compiler revision above and whose Flight lock resolves to the source revision above, run the downstream scripts named `sdk:generate:sdl` and `sdk:compile:sdl`; for example:

```sh
npm --prefix /path/to/flight-cpp run sdk:generate:sdl
FLIGHT_CPP_COMPILE_JOBS=12 npm --prefix /path/to/flight-cpp run sdk:compile:sdl
```

The generation command must complete the entire graph and write deterministic manifest/refusal output. The compile command is expected to remain nonzero until the 49 failures above are resolved; its JSON report, rather than the first diagnostic, is the production-readiness evidence.
