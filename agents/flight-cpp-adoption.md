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

## Latest validated candidate

The 2026-09-14 audit used an isolated checkout of flight-cpp `393f511884749d895f7f413dfdf6b1e7a95e238b`, Flight `1274ec5c923947dc64d5ffedcbd8169fc758cd9f`, and compiler `f44163c58b35a5cdd2625d1a1c041bceed7f1e61`. The dirty materialized checkout under this repository was not changed. This is a validated candidate, not yet the compiler's dependency pin.

The complete SDL profile processed all 154 packages and 2,851 modules. It emitted 1,008 dependency-closed headers and recorded 1,843 deterministic refusals: 984 direct emission refusals and 859 dependency-propagated refusals. The direct ledger includes 961 `unsupported-ir` refusals, 19 `internal-error` refusals, and four invalid target-name candidates. The internal errors are compiler defects rather than runtime requests: 18 are structural types whose recovered type arguments do not match the rebound declaration, and one is catch/await hoisting that leaves references to a catch binding outside its lexical scope.

GCC 15.2 compiled every emitted header independently against the candidate runtime. The exact result is 935 passing and 73 failing headers. This improves the same candidate from 830/1,025 in the first audit and 925/1,008 before the final imported-union, optional-chain, and callback fixes. Generation completes in roughly two minutes on this host; the compile report records the exact compiler and source revisions.

The remaining 73 failures are predominantly compiler-owned generated-code defects:

- nine incompatible structural-reference projections in `@flighthq/adjustments`;
- package-scope definition/name collisions, missing type declarations or forward declarations, and generated include cycles;
- optional/value projection errors, invalid reference/aggregate construction, and lvalue/reference conversion errors;
- unsupported or incorrectly lowered string iteration, indexed access, variant access, map access, and assignment forms; and
- four radix-bearing number-to-string calls that currently become a member call on `double`.

Do not repair these by rewriting generated headers in flight-cpp. The number-radix family needs a jointly versioned compiler/runtime spelling; the structural-reference assertions need a compiler schema/projection audit before weakening any runtime constraint. The other listed families belong in flight-compiler.

## Native build-system evidence

The candidate's ordinary CMake development preset built all 59 targets and passed all seven tests. A separate SDL-enabled CMake/Ninja configuration built 85 targets and passed all nine tests, including the SDL host and sound example. The host required the declared SDL3 and Vulkan development packages; both are now installed on the audit host.

Bazel 9.2.0 successfully analyzed and ran all 52 tests across 58 targets when invoked with an explicit C++20 toolchain option. The same build fails under Bazel's default C++17 mode because `flight/equality.hpp` uses C++20 concepts. flight-cpp must declare its C++20 language requirement in its Bazel target/toolchain contract rather than requiring every consumer to add `--cxxopt=-std=c++20`. The audit used the official GitHub mirror of the Bazel Central Registry because the primary registry returned transient 503 responses; this mirror override is an environment workaround, not a source change.

No missing portable runtime header or basic CMake/SDL implementation blocks the 1,008-header inventory. The downstream-owned work exposed by this audit is therefore narrow: declare C++20 for Bazel, coordinate the first released ABI number with the compiler, add the eventual radix-aware number formatting contract, and retain the preview-only status until the compiler-owned 73 native failures and 1,843 refusals are cleared.

The reproduction commands in the isolated flight-cpp checkout were:

```sh
npm run sdk:generate:sdl
FLIGHT_CPP_COMPILE_JOBS=12 npm run sdk:compile:sdl
cmake --preset development
cmake --build --preset development --parallel 12
ctest --preset development
cmake -S . -B out/cmake/sdl -G Ninja -DCMAKE_BUILD_TYPE=Debug -DBUILD_TESTING=ON -DFLIGHT_CPP_BUILD_EXAMPLES=ON -DFLIGHT_CPP_BUILD_HOST_SDL=ON -DFLIGHT_CPP_WARNINGS_AS_ERRORS=ON
cmake --build out/cmake/sdl --parallel 12
ctest --test-dir out/cmake/sdl --output-on-failure
bazel test //... --cxxopt=-std=c++20 --test_output=errors
```

## Release and dependency contract

- [ ] Advance the unreleased C++ ABI coherently. The compiler and pinned runtime currently assert ABI 1, but ABI 1 was never released. Land the intended ABI revision in `flight-cpp`, update the compiler assertion and dependency lock in the same integration, and compile an emitted header against the new pin.
- [ ] Keep the `flight-runtime-contract/2` capability declaration synchronized with runtime implementations. A compiler mapping must not land as an apparently available capability while the pinned runtime lacks its header or symbol.
- [ ] Update the reciprocal repository locks deliberately: `flight-compiler` pins the runtime it compiles against; `flight-cpp` pins the compiler and Flight corpus used for regeneration. Record the exact revisions in generated manifests.
- [ ] Make the new runtime surface available through installed CMake targets and Bazel targets, including transitive native dependencies and arbitrary-toolchain selection. Prove clean, reproducible builds on the supported host environments rather than relying on ambient SDKs.

## Binary data and text

- [ ] Complete adoption of `flight/array_buffer.hpp` and `flight::ArrayBuffer`. The implementation at the current pin has stable shared backing storage for zero-length and sized buffers; the emitted-SDK and oracle gates in the completion rule remain.
- [ ] Complete adoption of typed-array construction from `flight::ArrayBuffer`, the `buffer` view, `byte_length`, and `byte_offset`. The current implementation shares one backing store across views, as TypeScript requires; copying the input bytes is not compatible.
- [ ] Complete adoption of `flight/data_view.hpp` and `flight::DataView`. The current implementation has buffer, offset, and length construction plus the emitted numeric getters/setters; the remaining adoption gate is emitted use and TypeScript-versus-native coverage of bounds, unaligned reads, both endian modes, NaN, and infinities.
- [ ] Add `flight/text_decoder.hpp` and `flight::TextDecoder::decode` for `Uint8Array` input. Define the supported encoding and malformed UTF-8 behavior and compare it with the TypeScript oracle.
- [ ] Extend `flight::String` with `from_code_point`, including astral code points and invalid scalar values.
- [ ] Extend `flight::Array::splice` for insertion calls such as `splice(index, 0, value)`. The compiler ambient/member contract now emits the call without erasure. The downstream overload must be `template <typename... Items> requires (std::constructible_from<Value, Items&&> && ...) [[nodiscard]] Array splice(std::ptrdiff_t begin_index, std::ptrdiff_t count, Items&&... items)`: normalize the boundary once, return the removed values, and insert the forwarded items in source order at that same boundary. The pinned runtime still has only the one/two-argument removal overload, so native compilation remains fail-closed until it adopts this signature.

### Array-like boundary

None of the three TypeScript array-like names is a sound alias for one concrete type in the current runtime. They remain explicit compiler refusals rather than permissive mappings:

| Source type | Flight uses that fix the contract | Minimum sound C++ contract | Compiler boundary |
| --- | --- | --- | --- |
| `ArrayLike<T>` | Read-only numeric inputs span `Array<T>`, typed arrays, polygon arrays, returned scratch views, stored `AnimationTrack` fields, and caller/decoder-provided glTF buffers. Code observes `length` and numeric indexing without requiring one concrete owner. | A shared-owner, read-only `SequenceView<T>` with `length` and indexed access, zero-copy adapters for `flight::Array<T>` and every typed array, and an owner-preserving type-erased adapter for other structurally compatible sources. Stored fields and returned views make a borrowed `std::span<const T>` insufficient. | Not a closed intrinsic. Do not map it to `flight::Array<T>`, one typed array, or `std::span`; each rejects valid TypeScript sources or loses lifetime/identity. `Readonly<ArrayLike<T>>` has the same representation requirement. |
| `ArrayBufferLike` | Physics 2D/3D ABI typed-array fields intentionally accept alternate or native linear-memory backing, while `MeshGeometryRuntime` retains a buffer beside its offset and `DataView`. ES2022 also includes `SharedArrayBuffer` in `ArrayBufferTypes`. | A common shared backing contract for ordinary, shared, and host/external buffers, with stable identity, byte length, lifetime, mutability/concurrency policy, and zero-copy typed-array/DataView construction. The typed-array backing type must not be erased to the current concrete `flight::ArrayBuffer` member. | It may be compiler-expanded only when the checker proves a closed `ArrayBufferTypes[keyof ArrayBufferTypes]` alternative set and every alternative has a compatible runtime binding. The current Flight program includes `SharedArrayBuffer` and permits host augmentation, while the pin implements neither shared/external backing nor generic typed-array backing, so mapping it to `flight::ArrayBuffer` would narrow the source contract. |
| `ArrayBufferView` | Production `NetBody` accepts any typed-array or `DataView` payload; DOM/WebGL/WebGPU boundaries also consume view ranges rather than copied whole buffers. | An owner-preserving byte-view carrier containing backing identity, byte offset, byte length, and dynamic view kind, with zero-copy conversions from `DataView` and every supported typed array. It must retain enough kind information for target APIs that distinguish element views. | Not safely enumerable as a compiler-only variant: TypeScript's interface is structurally open, the standard library includes views absent from the pin (including BigInt typed arrays), and the runtime has no common view base/carrier. Materializing only its three visible properties or copying bytes loses source identity and dynamic kind. |

A future compiler intrinsic for a checker-proven closed `ArrayBufferLike` is the only compiler-only computation in this family: expand the alias to its exact alternatives and use their declared runtime representations. The sequence and view interfaces still need runtime carriers because their public values cross calls, returns, and stored fields. Add focused native conversion and aliasing oracles before declaring any of these external bindings available.

## Dependent callable parameter packs

The Signals `connection`, `emitter`, and `safe` modules use `...args: Parameters<T>` where `T extends (...args: any[]) => void`. This is not the closed `Parameters<ConcreteFunction>` tuple projection the compiler already supports. The current IR models `args` as one array-valued rest binding, while `std::function<R(P...)>` erases whether each source parameter was fixed, optional, or rest. Emitting an unconstrained or merely invocable C++ `Args...` would admit calls outside the source signature; requiring exact `std::function<R(Args...)>` equality instead rejects valid optional, rest, callable-object, and function-conversion cases.

- [x] Add target-neutral dependent callable-pack evidence that ties the rest binding to its callable type parameter, preserves its callable constraint, and distinguishes terminal pack expansion from ordinary array use. `flight-compiler-dependent-callable-pack/1` is attached only to a direct rest `Parameters<T>` projection or the `any[]` rest implementation beneath an explicit callable-type-parameter erasure cast; aliases, free `any[]` rests, and incoherent evidence remain refused.
- [ ] Adopt the compiler's versioned Flight C++ callable-signature and storage ABI. [`cppCallableSignatureAbi.ts`](../packages/compiler-backend-cpp/src/cppCallableSignatureAbi.ts) is the exact spelling contract: `flight::callable_signature_v1<Callable>` exposes `template <typename... Arguments> static constexpr bool accepts`, with its signature metadata retaining each required/optional/rest role and position type, and `template <typename Callable, typename Implementation> Callable flight::bind_callable_v1(Implementation&&)` constructs only a representation whose recorded signature accepts the implementation. The trait must cover every compiler-emitted callable representation, including callable wrappers; implicit C++ convertibility is not evidence. The pin does not provide these symbols yet.
- [ ] Complete native oracles for the emitted exported rest signatures, generic function expressions, and terminal pack expansion. Compiler emission now treats these as one constrained operation and refuses ordinary pack-value use, nonterminal expansion, aliases, generic callable constraints, and incoherent evidence. Keep downstream adoption open until zero-, one-, and multi-argument signals, optional/rest callables, nested forwarding, and invalid calls pass TypeScript-versus-native oracles.

## RegExp and URL

- [ ] Add `flight/regexp.hpp`, `flight::RegExp`, and `flight::RegExpExecArray` with constructor and literal paths, flags, captures, `exec`, and `test`. Global expressions must preserve observable match position across calls.
- [ ] Extend `flight::String::match` and `flight::String::replace` with the RegExp overloads emitted by the compiler. Cover unmatched captures, global replacement, replacement callbacks, and empty matches rather than assuming `std::regex` is behaviorally equivalent.
- [ ] Add `flight/url.hpp` and `flight::Url`, including construction and the `protocol` property. Cover protocol spelling, relative/invalid input policy, and the exception path used by URL probes.

## JSON, numbers, and objects

- [ ] Add `flight/json.hpp` with `flight::Json::parse` and `flight::Json::stringify`. Stringification must accept the emitted replacer and indentation arguments. Choose and version a JSON value representation that can preserve null, boolean, number, string, array, and object values; do not substitute an unrelated opaque type for `unknown`.
- [ ] Add `flight/number.hpp` with `flight::parse_int` and `flight::to_number`, plus the currently mapped integer predicate. Cover radix inference, leading whitespace/signs, partial parses, NaN, infinities, empty strings, and safe-integer boundaries.
- [ ] Add `flight/object.hpp`, `flight::Object`, and generic `flight::object_keys`, `flight::object_entries`, and `flight::object_assign`. Preserve the emitted key/value types, source-order overwrites, target identity, and deterministic JavaScript-compatible key order where it is observable.
- [ ] Adopt the compiler's eventual portable `Record<K, V>` storage contract for string, number, and symbol key domains. Missing-key reads must preserve JavaScript `undefined` semantics without inserting a default value; writes must preserve target identity; enumeration must use JavaScript-compatible integer/string/symbol order. The current `std::unordered_map::operator[]` representation violates both missing-key and ordering semantics even when `K` does not include `Symbol`; do not treat a hash specialization by itself as completion.

## Internationalization

- [ ] Add `flight/intl.hpp` with the compiler-named option and formatter types: `IntlCollator`, `IntlDateTimeFormat`, `IntlListFormat`, `IntlNumberFormat`, `IntlPluralRules`, and `IntlRelativeTimeFormat`, their option records, `IntlPluralRule`, and `IntlRelativeTimeFormatUnit`.
- [ ] Implement the emitted `compare`, `format`, and `select` methods and locale-list constructors. Define the supported locale/options subset explicitly. If ICU or another native library supplies it, pin and expose that dependency through both CMake and Bazel so output does not silently vary with the build machine.
- [ ] Add behavioral oracles for the locale-independent baseline and deterministic tests for unsupported locales/options. Environment-dependent locale behavior must be an explicit runtime policy, not an accidental machine input.

## Symbols and Entity

- [ ] Add `flight/symbol.hpp`, `flight::Symbol`, and `flight::Symbol::for_key`. Repeated calls with the same key must preserve symbol identity. This is required by the generated Entity runtime key.
- [ ] Compile the emitted Entity header and a dependent construction/access path against the pinned runtime. The runtime must provide `flight::ReferenceEnabled` and the existing reference helpers used by generated interface-derived types.
- [ ] Implement and package `flight/structural_ref.hpp` for the compiler's open structural-row ABI described below. The compiler now preserves `NodeOf<Traits>`, `Readonly<Partial<D>>`, and `EntityConstruction<Host & Capabilities>` as schemas and shared-owner views instead of flattening or erasing their fields.
- [ ] Preserve the whole target of `createGuardedEntity<Type extends object>(Type & Entity)`. This is an open row, not erasable predicate evidence: public callers may add arbitrary `Type` fields, and the guard tests read and write those fields as well as `EntityRuntimeKey`. The disabled path must return the same reference; the enabled path needs a distinct Proxy identity that forwards every target field while intercepting runtime-slot writes. A sound contract therefore needs a whole-target generic reference plus an owner-preserving Proxy carrier; erasing to `Type` loses the entity slot, erasing to `Entity` loses caller fields, and flattening invents a generic layout. The compiler may erase `T & Entity` only when `T`'s declared constraint already proves `T extends Entity`; this production signature proves only `T extends object` and must remain refused.

### Open structural rows

The compiler emits open generic intersections and mapped views as `flight::StructuralRef<Schema>`. Schemas use `flight::RowOf<T>`, variadic `flight::RowMerge<...>`, `flight::RowPartial<Row>`, `flight::RowReadonly<Row>`, and `flight::RowWritable<Row>`. Construction and projection use `flight::make_structural_ref<Schema>(flight::row_field<flight::RowKey<"name">>(value), ...)` and `flight::structural_ref_cast<Target>(source)`. Named access uses `flight::row_get<flight::RowKey<"name">>(ref)` and `flight::row_set<flight::RowKey<"name">>(ref, value)`; computed symbol access uses `flight::row_get<Value>(ref, key)` and `flight::row_set(ref, key, value)`. Closed ordinary interfaces and object records retain their existing native representations.

The narrow structural-proxy ABI is `flight::make_structural_write_proxy<Schema>(flight::StructuralRef<Schema> target, flight::Symbol intercepted_key, BeforeWrite before_write) -> flight::StructuralRef<Schema>`. It allocates a distinct `RowOwner` whose reads, presence queries, and writes delegate to the target owner. A write whose canonical symbol identity equals `intercepted_key` invokes `before_write` before delegation, propagating an exception without performing the write; every other write delegates directly. The proxy therefore has distinct structural-reference identity while target and proxy observe the same field storage, including fields contributed by an open `RowOf<Type>`. Projections of the proxy retain the proxy owner, and proxying a proxy composes the delegates and hooks in outer-to-inner order. The compiler elects the `structural-proxy` capability only for the exact Entity-style single-`set` handler that performs this forwarding assignment and returns `true`; direct `Proxy` values, extra traps, different forwarding, or nonstructural targets remain refused.

- [ ] Provide one shared `RowOwner` per source object and one presence-bearing cell per canonical TypeScript property identity. Every partial, readonly, writable, merge, and projected view must retain that owner and the same cells; structural-reference equality is owner identity.
- [ ] Implement `make_structural_write_proxy` with a distinct delegating owner and pre-write symbol hook, then prove disabled identity, enabled distinct identity, bidirectional arbitrary-field forwarding, intercepted runtime-slot writes, exception ordering, and nested proxy composition.
- [ ] Define `RowKey` identity from the full canonical string spelling. Computed symbol keys use stable source symbol identity. Hashing may accelerate lookup but cannot define equality or merge collisions.
- [ ] Make `RowMerge` collision validation occur when all schema arguments are instantiated. Exact mutable cell ABIs may merge. A readonly broader view may accept a schema-proven reference projection, and source-equivalent scalar representations such as literal/string may share one cell. Incompatible writable refinements must fail at compile time. Required beats optional for presence, while readonly/writable wrappers change only access permission, never storage identity.
- [ ] Keep construction and projection schema-checked: every required field must exist before a constructed reference escapes, unknown fields are rejected, and casts may only project between compatible structural-row/reference schemas. No operation may infer offsets or native object layout from the schema spelling.
- [ ] Add native compile and aliasing oracles for all eight `NodeOf<Traits> & Has*` aliases, `Readonly<Partial<D>>`, and `EntityConstruction<Host & Capabilities>`, including compatible refinements, incompatible mutable collisions, absent optional fields, readonly writes, and owner identity across projections.

## Conditional capability facets

`TrayIconForHost<HostType>` remains generic at every emitted production use. Each tray capability is selected by a conditional test for one literal member of `HostType["tray"]`, with `unknown` as the false intersection arm. The checker therefore cannot select the branch while emitting the generic API. Erasing those arms to `TrayIcon` would admit unsupported tray operations, selecting every true arm would claim capabilities absent from some hosts, and ordinary multiple inheritance would duplicate the mutable `TrayIcon`/`Entity` referent through every facet.

- [x] Preserve target-neutral conditional-facet evidence for the proven nested-required Tray pattern: the host type parameter, each closed literal member path, the marker-only true facet, and the `unknown` false intersection identity. Optional paths, open key domains, runtime-bearing facets, incompatible bases, and duplicate paths remain refusals.
- [ ] Implement and package `flight/conditional_facet_ref.hpp`. It must provide zero-storage facet tags, `flight::FacetRef<Base, Tag>` holding exactly one `flight::Ref<Base>`, `flight::MemberPath<Accessors...>` with requiredness checked before every reference unwrap, `flight::RequiredMemberFacet<Tag, Path>`, and `flight::ConditionalFacetRef<Base, Host, Rules...>` whose conversions expose only the facets proven by `Host`. Plain base references must not implicitly gain facets.
- [ ] Implement `flight::assume_conditional_facets<Target>(flight::Ref<Base>)` as the single explicit, auditable acquisition wrapper used by generated Tray construction. It must preserve the same referent and may target only the compiler-planned conditional facet type; it does not dynamically add capabilities. Prove capable and incapable hosts, multiple simultaneous facets, referent identity, invalid facet calls, and each nested required-member path with TypeScript-versus-native oracles.

## Weak identity caches

The bounded eight-package diagnostic at compiler revision `61e63e5` and `flight-cpp` revision `538fe1d` exposes five direct `WeakMap` refusals. The diagnostic host manifest deliberately gives every external object shared ownership, but that proves neither a usable weak owner nor the identity/hash/equality operations required by a native key container.

| Refused module | First unsupported key/value pair | Exact representation boundary |
| --- | --- | --- |
| `GlContextRuntime` | `CanvasImageSource` → `WebGLTexture` | `CanvasImageSource` is the six-arm DOM union of image, video, canvas, bitmap, offscreen-canvas, and video-frame objects. The host needs one identity-preserving weak-key carrier across those alternatives. `WebGLTexture` is a host value that must remain storable without changing its native lifetime policy. |
| `WgpuDeviceRuntime` | `CanvasImageSource` → `WgpuTextureEntry` | The same host weak-key proof is absent. The value is a compiler-proven Flight reference to the local `WgpuTextureEntry` interface, so it is not the refusal. |
| `WgpuQuadBatchResources` | `GPUShaderModule` → `Map<string, GPURenderPipeline>` | `GPUShaderModule` is a host handle whose shared ownership declaration does not define weak access, identity, hashing, or equality. The value is the represented Flight map of strings to host pipeline handles. |
| `WgpuRenderState` | `CanvasImageSource` → `WgpuTextureEntry` | This newly exposed blocker is the same `CanvasImageSource` host-key ABI gap as the device runtime, not a new local interface-rebinding defect. |
| `WgpuScene3DRuntime` | `object` → `unknown` at `shadedMaterialBindingCache` | The compiler now emits the two opaque fields as `flight::WeakMap<flight::Ref<void>, flight::ErasedValue>` and turns their exact immutable-local assertions into checked shared views. `shadedMaterialPlanCache` has the same shape. The pinned runtime still needs the erasure and view contract below. |

The remaining texture caches in the GL and WGPU runtime records use `TextureSource`, `ExternalTexture`, `RenderTexture`, or `ImageResource` keys. Those imported Entity-derived interfaces already have compiler-proven `flight::Ref<T>` identity; anonymous/local entry records and host GPU handles supply their corresponding value representations. The compiler now maps those keys to the planned `flight::WeakMap<Key, Value>` ABI instead of the old strong `std::unordered_map` fallback. The pinned runtime still has no weak-map header or implementation, so emitted consumers remain downstream-blocked until the contract below lands.

- [ ] Implement and package `flight/weak_map.hpp` with `flight::WeakMap<Key, Value, Policy = default_weak_key_policy_t<Key>>`, non-enumerable `get`, `set`, `has`, and `delete` behavior, weak key retention, stable identity comparison, and entry expiry when the last strong key owner disappears. The default policy must cover `flight::Ref<T>`, `flight::Ref<void>`, and closed variants of Flight references.
- [ ] Implement the external policy concept consumed by `flight::WeakMap<Key, Value, Policy>`: nested `weak_type` and `identity_type`, plus static `weaken`, `lock`, `identity`, `hash`, and `equal` operations with the signatures documented in `docs/cpp-package-compilation.md`. Neither the weak carrier nor identity token may retain the key, and lock/identity/hash/equality must agree on one host object lifetime.
- [ ] Add `weakKeyPolicyTargetName` to the constituent shared, non-null type bindings for `CanvasImageSource` and to the `GPUShaderModule` binding supplied by each supported host adapter. Every member of a host union must name the same cohesive policy.
- [x] Define the compiler side of the two shaded-material cache boundaries. Only exact `WeakMap<object, unknown>` fields lower to `flight::WeakMap<flight::Ref<void>, flight::ErasedValue>`, and only immutable local assertions with a proven Flight-reference key and represented value acquire `flight::checked_weak_map_view<K, V>`. Other `unknown` uses and view escapes stay refused.
- [ ] Implement `flight::ErasedValue`, `flight::BadErasedValueCast`, `flight::WeakMapView<Key, Value>`, and `flight::checked_weak_map_view<Key, Value>`. Erasure must retain the exact emitted value type, checked reads must fail deterministically on a different tag, writes must update that tag, and the view must share the underlying weak map storage rather than copy entries. Typed Flight keys must erase to `flight::Ref<void>` without changing identity; scalar and reference values both need round-trip tests.
- [ ] Prove the opaque-cache contract natively: two views observe one storage, a wrong typed view fails on `get`, `has` and `delete` remain key operations, overwriting changes the stored tag, values do not affect key expiry, and no view or erased carrier introduces enumeration.

No unchecked compiler-only relaxation is sound for the two `unknown` values: spelling them as `void` or an untagged `flight::Any` would fabricate recovery semantics that the TypeScript assertions do not prove. The elected ABI instead treats the assertion as an explicit checked acquisition, matching the backend's existing fail-closed treatment of asserted union alternatives.

## Host-provided bindings

These are not portable runtime globals and must not become unconditional `flight-cpp` core bindings. A host adapter or consuming application supplies a versioned `flight-cpp-external-bindings/1` manifest and the named native headers.

- [ ] Make SDK regeneration accept one or more explicit external-binding manifests, validate their schema and complete reachable symbol coverage, and record each manifest's stable identity, digest, and selected profile in generated provenance. Keep the manifest-free sweep as the portable floor, but do not treat its host refusals as proof that a configured native profile is incomplete.
- [ ] Publish maintained binding profiles separately for portable core, headless native, SDL/OpenGL, SDL/Vulkan, SDL/WebGPU, and Node/tooling integration. Profiles compose only when symbol ownership, nullability, lifetime, and value/type-space declarations agree; do not introduce a blanket opaque or dynamic fallback.
- [ ] Provide a timing-host value binding for `performance` with a callable `now` member returning monotonic milliseconds. `@flighthq/log` reaches `performance.now()` behind a `typeof performance !== 'undefined'` fallback to `Date.now()`; native emission still requires an explicit binding because the ambient value is reachable. The binding must state the native header and qualified value/member names and define its time origin and monotonicity. Do not rewrite it to `flight::Date::now`: wall-clock time can move backward and is not the source contract.
- [ ] Provide a Node/tooling host manifest for `process`, including the members reached by Flight's shell and tool-pipeline packages.
- [ ] Provide a browser/media host manifest for `navigator`, `Permissions`, `PermissionDescriptor`, `MediaDevices`, `MediaStream`, and `MediaStreamTrack`.
- [ ] Supply a cohesive `weakKeyPolicyTargetName` policy for each supported native `CanvasImageSource`, `GPUShaderModule`, or similar `WeakMap` key. Ownership and nullability evidence alone do not prove compatibility with the emitted key container.
- [ ] Add a manifest compile test for each supported host adapter so every reachable ambient type, value, constructor, and static member has exactly one binding.
- [ ] Keep SDL, native GL, Dawn/wgpu-native, Vulkan, and platform window handles in their respective host packages. Generated render packages own rendering behavior; the compiler and core runtime do not learn host SDK APIs.

## SDK regeneration and release gate

- [ ] Regenerate the pinned Flight package graph with the adopted runtime and host manifests, then commit deterministic source/output ownership, dependency, refusal, and initialization manifests in `flight-cpp`.
- [ ] Add installed/exported `Flight::Sdk` CMake and Bazel targets driven from the generated package manifest. Compile every dependency-closed emitted header and implementation unit through both surfaces, with an explicit arbitrary-toolchain lane and at least one hermetic/reproducible locked-toolchain lane.
- [ ] Run TypeScript-versus-native behavioral oracles for every adopted capability with runtime semantics, then make the same corpus a release gate.
- [ ] Publish generated SDK targets only when their complete dependency closure compiles under the declared binding profile. Partial report output remains useful for bring-up but must not masquerade as a production SDK target.

## Compiler-owned follow-up, not flight-cpp runtime work

The complete-corpus gate is now the prioritization source. First remove the 19 internal errors and four invalid target-name candidates so every unsupported module reaches a stable refusal. Then work down the 961 direct `unsupported-ir` entries by dependency-closure impact, while compiling every newly emitted header immediately. In parallel, resolve the 73 current native failures, beginning with the nine structural-reference projections and the repeated definition/name, missing declaration, optional projection, and reference-construction families. Fixed-arity calls may continue to refuse unbounded spreads because their ABI has no runtime arity; top-level `await` and nested module-scoped `var` may likewise remain explicit refusals until their semantics are designed.

Do not compensate for compiler refusal boundaries with permissive runtime types, weakened structural assertions, or downstream source rewriting. Rerun generation and the independent-header matrix after each coherent compiler arc, and add flight-cpp surface only when the emitted contract demonstrates a genuine runtime requirement.
