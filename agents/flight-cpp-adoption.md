# flight-cpp adoption register

This register holds C++ runtime and integration work discovered by `flight-compiler` until [`flight-cpp`](https://github.com/flighthq/flight-cpp) adopts it. The compiler owns emitted names, lowering, package-graph semantics, and runtime capability declarations. `flight-cpp` owns the implementation, CMake and Bazel packaging, native dependencies, conformance tests, and release.

The binding table in [`cppRuntimeExternalSymbolBinding.ts`](../packages/compiler-backend-cpp/src/cppRuntimeExternalSymbolBinding.ts) and the ambient member table in [`cppAmbientMemberBinding.ts`](../packages/compiler-backend-cpp/src/cppAmbientMemberBinding.ts) are the exact compiler contracts. This document records adoption state rather than defining a second API.

## Completion rule

Mark an item adopted only after all of the following are true:

1. The required API exists in the `flight-cpp` revision pinned by `flight-compiler`.
2. CMake installs and exports it, and Bazel exposes it without assuming the machine's default compiler or dependency locations.
3. At least one compiler-emitted header using the capability compiles against that exact pin.
4. Runtime behavior with observable TypeScript semantics has a TypeScript-versus-native oracle.
5. The Flight SDK package-graph regeneration records no missing runtime symbol for the adopted capability.

When the downstream repository contains an equivalent maintained register, replace this document with a link to it. Do not leave two independently maintained checklists.

## Current pinned gap

At `flight-cpp` revision `70656d466841ae7ce9b014a36eb81a442a79ddb5`, the compiler's `flight-cpp` binding profile emits ten runtime headers that the pinned checkout does not contain:

- `flight/array_buffer.hpp`
- `flight/data_view.hpp`
- `flight/intl.hpp`
- `flight/json.hpp`
- `flight/number.hpp`
- `flight/object.hpp`
- `flight/regexp.hpp`
- `flight/symbol.hpp`
- `flight/text_decoder.hpp`
- `flight/url.hpp`

This is a pin-specific snapshot, not an additional contract. Update it whenever `dependencies.lock.json` advances. Existing headers such as `flight/string.hpp` and `flight/typed_array.hpp` also require the extensions named below, so the absence list alone is not the completion gate.

## Release and dependency contract

- [ ] Advance the unreleased C++ ABI coherently. The compiler and pinned runtime currently assert ABI 1, but ABI 1 was never released. Land the intended ABI revision in `flight-cpp`, update the compiler assertion and dependency lock in the same integration, and compile an emitted header against the new pin.
- [ ] Keep the `flight-runtime-contract/2` capability declaration synchronized with runtime implementations. A compiler mapping must not land as an apparently available capability while the pinned runtime lacks its header or symbol.
- [ ] Update the reciprocal repository locks deliberately: `flight-compiler` pins the runtime it compiles against; `flight-cpp` pins the compiler and Flight corpus used for regeneration. Record the exact revisions in generated manifests.
- [ ] Make the new runtime surface available through installed CMake targets and Bazel targets, including transitive native dependencies and arbitrary-toolchain selection. Prove clean, reproducible builds on the supported host environments rather than relying on ambient SDKs.

## Binary data and text

- [ ] Add `flight/array_buffer.hpp` and `flight::ArrayBuffer`. It needs stable shared backing storage suitable for zero-length and sized buffers.
- [ ] Extend all typed-array implementations with construction from `flight::ArrayBuffer`, a `buffer` view, `byte_length()`, and `byte_offset`. Add `ArrayBuffer::byte_length()` as well. Views over one buffer must observe one another's writes; copying the input bytes is not compatible with TypeScript semantics.
- [ ] Add `flight/data_view.hpp` and `flight::DataView`, including buffer, offset, and length construction and `get_float64(offset, littleEndian)`. Cover bounds failures, alignment-independent reads, both endian modes, NaN, and infinities.
- [ ] Add `flight/text_decoder.hpp` and `flight::TextDecoder::decode` for `Uint8Array` input. Define the supported encoding and malformed UTF-8 behavior and compare it with the TypeScript oracle.
- [ ] Extend `flight::String` with `from_code_point`, including astral code points and invalid scalar values.

## RegExp and URL

- [ ] Add `flight/regexp.hpp`, `flight::RegExp`, and `flight::RegExpExecArray` with constructor and literal paths, flags, captures, `exec`, and `test`. Global expressions must preserve observable match position across calls.
- [ ] Extend `flight::String::match` and `flight::String::replace` with the RegExp overloads emitted by the compiler. Cover unmatched captures, global replacement, replacement callbacks, and empty matches rather than assuming `std::regex` is behaviorally equivalent.
- [ ] Add `flight/url.hpp` and `flight::Url`, including construction and the `protocol` property. Cover protocol spelling, relative/invalid input policy, and the exception path used by URL probes.

## JSON, numbers, and objects

- [ ] Add `flight/json.hpp` with `flight::Json::parse` and `flight::Json::stringify`. Stringification must accept the emitted replacer and indentation arguments. Choose and version a JSON value representation that can preserve null, boolean, number, string, array, and object values; do not substitute an unrelated opaque type for `unknown`.
- [ ] Add `flight/number.hpp` with `flight::parse_int` and `flight::to_number`, plus the currently mapped integer predicate. Cover radix inference, leading whitespace/signs, partial parses, NaN, infinities, empty strings, and safe-integer boundaries.
- [ ] Add `flight/object.hpp`, `flight::Object`, and generic `flight::object_keys`. Preserve the emitted key type and deterministic JavaScript-compatible key order where it is observable.

## Internationalization

- [ ] Add `flight/intl.hpp` with the compiler-named option and formatter types: `IntlCollator`, `IntlDateTimeFormat`, `IntlListFormat`, `IntlNumberFormat`, `IntlPluralRules`, and `IntlRelativeTimeFormat`, their option records, `IntlPluralRule`, and `IntlRelativeTimeFormatUnit`.
- [ ] Implement the emitted `compare`, `format`, and `select` methods and locale-list constructors. Define the supported locale/options subset explicitly. If ICU or another native library supplies it, pin and expose that dependency through both CMake and Bazel so output does not silently vary with the build machine.
- [ ] Add behavioral oracles for the locale-independent baseline and deterministic tests for unsupported locales/options. Environment-dependent locale behavior must be an explicit runtime policy, not an accidental machine input.

## Symbols and Entity

- [ ] Add `flight/symbol.hpp`, `flight::Symbol`, and `flight::Symbol::for_key`. Repeated calls with the same key must preserve symbol identity. This is required by the generated Entity runtime key.
- [ ] Compile the emitted Entity header and a dependent construction/access path against the pinned runtime. The runtime must provide `flight::ReferenceEnabled` and the existing reference helpers used by generated interface-derived types.

## Host-provided bindings

These are not portable runtime globals and must not become unconditional `flight-cpp` core bindings. A host adapter or consuming application supplies a versioned `flight-cpp-external-bindings/1` manifest and the named native headers.

- [ ] Provide a Node/tooling host manifest for `process`, including the members reached by Flight's shell and tool-pipeline packages.
- [ ] Provide a browser/media host manifest for `navigator`, `Permissions`, `PermissionDescriptor`, `MediaDevices`, `MediaStream`, and `MediaStreamTrack`.
- [ ] Add a manifest compile test for each supported host adapter so every reachable ambient type, value, constructor, and static member has exactly one binding.
- [ ] Keep SDL, native GL, Dawn/wgpu-native, Vulkan, and platform window handles in their respective host packages. Generated render packages own rendering behavior; the compiler and core runtime do not learn host SDK APIs.

## SDK regeneration and release gate

- [ ] Regenerate the pinned Flight package graph with the adopted runtime and host manifests, then commit deterministic source/output ownership, dependency, refusal, and initialization manifests in `flight-cpp`.
- [ ] Compile every dependency-closed emitted header and implementation unit through both the CMake and Bazel build surfaces.
- [ ] Run TypeScript-versus-native behavioral oracles for every adopted capability with runtime semantics, then make the same corpus a release gate.
- [ ] Publish generated SDK targets only when their complete dependency closure compiles. Partial report output remains useful for bring-up but must not masquerade as a production SDK target.

## Compiler-owned follow-up, not flight-cpp runtime work

The observed compiler-owned generation gaps now have explicit lowering: named barrel requests split into symbol-scoped dependency edges; imported iterable and tuple evidence reaches for-of destructuring; array construction and `Array.push` materialize unbounded iterable spreads in source order; binding-pattern evidence reaches inferred anonymous object helpers; and synchronous executable top-level control flow uses the ordered module-initialization lane. Fixed-arity calls still refuse unbounded spreads because their ABI has no runtime arity, while top-level `await` and nested module-scoped `var` remain explicit refusals. Do not compensate for these refusal boundaries with permissive runtime types or downstream source rewriting. Rerun the downstream adoption gates above and add only the runtime surface the emitted contract actually requires.
