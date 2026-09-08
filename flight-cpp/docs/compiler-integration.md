# Compiler integration

The C++ backend has an explicit `runtimeProfile` election:

- `flight-cpp` maps TypeScript arrays, maps, sets, strings, typed arrays, promises, and dates to the namespaced semantic runtime and includes `<flight/runtime.hpp>` automatically.
- `standard-library` is the compatibility default of the low-level backend API. It retains the provisional STL-oriented representation and does not claim TypeScript-equivalent collection semantics.

The packaged `flight-compile --target cpp` command elects `flight-cpp` by default. A caller must ask explicitly for `--runtime-profile standard-library` to receive provisional STL output.

`runtimeHeader` overrides the automatic header spelling without changing the selected bindings, which lets an embedding codebase vendor or wrap the runtime. Adding methods to namespace `std` remains undefined behavior and is not an acceptable bridge.

The compiler owns `tests/generated/semantic_runtime.hpp`: a package test regenerates it from `semantic_runtime.ts` and refuses drift, while CMake compiles and executes it against this runtime. Run `npm run cpp:conformance:update` at the repository root after an intentional emitter change.

## Current maturity boundary

The versioned [`flight-portable-typescript/1`](../conformance/portable-typescript-v1.json) profile is the input contract. The compiler refuses code outside the boundary instead of emitting source known to be invalid. Every present refusal is named in the [exception ledger](../conformance/known-exceptions.json), including the compiler/IR capability that must remove it.

The generated golden corpus uses the semantic profile. Native compilation accepts GCC or Clang and includes the real runtime rather than a permissive stub. The behavioral oracle executes the same fixture calls under Node and native C++ and compares canonical answers whenever a C++ compiler is available. CI additionally builds runtime and installed consumers with GCC, Clang, AppleClang, and MSVC.

Closed multi-member unions elect `std::variant` only when every source alternative has a distinct C++ representation. `typeof` and discriminant guards consume checker-proven union-member evidence, narrowed reads use checked `std::get`, and a source type assertion becomes the same checked access, failing with `std::bad_variant_access` when the runtime alternative disagrees. Duplicate target representations and optional variants remain outside the profile rather than producing ambiguous or nested storage.

For-in bindings carry their JavaScript string-key type through neutral semantic and variable-hoisting lowering; C++ consumes that evidence rather than inferring a type from loop syntax. A closed-record key plan applies only when the runtime value has exactly its statically declared own enumerable string keys. Structural extra properties and inherited enumerable properties are outside `flight-portable-typescript/1`; open object enumeration requires a future runtime-backed representation.

Mutable closure bindings consume the target-neutral capture, escape, and mutation analysis. C++ elects a `std::shared_ptr<T>` cell only when a non-module binding is mutable or the evidence records mutation; lambdas copy that cell, so sibling closures, outer reads, and returned closures retain one binding and its lifetime. Parameters are promoted after default initialization, in source order. Module bindings remain direct and read-only captures remain value copies. This is JavaScript-style serialized state, not an assertion that concurrent calls may mutate a cell without external synchronization.

The cell preserves binding identity, but it cannot manufacture referent identity for values the C++ profile represents by value. Captured mutation of `flight::Array`, `flight::Map`, `flight::Set`, and typed-array referents is supported because their runtime handles already share storage. Captured structural-object referent mutation, uninitialized cells, and for-in capture storage continue to refuse exactly rather than copy or zero-initialize state.

Remaining graduation work is intentionally narrow: finish for-in capture storage, select production Unicode and time-zone providers, prove a supported 32-bit configuration, and hold performance/ABI compatibility gates over at least one release-candidate cycle.

## Binding profiles

| TypeScript surface | Current provisional target | Semantic target |
| --- | --- | --- |
| `Promise<T>` | `FlightTask<T>` | `flight::Task<T>` |
| `Date` | `FlightDate` | `flight::Date` |
| `Array<T>` | `std::vector<T>` | `flight::Array<T>` |
| `Map<K, V>` | `std::unordered_map<K, V>` | `flight::Map<K, V>` |
| `Set<T>` | `std::unordered_set<T>` | `flight::Set<T>` |
| typed arrays | `std::vector<element>` | `flight::TypedArray<element>` aliases with view identity |
| `string` | `std::string` | UTF-16 `flight::String` with explicit UTF-8 and Unicode-service boundaries |

The compiler owns the decision and lowering tables. `flight-cpp` owns their maintained implementations, headers, packaging, and behavioral conformance. Neither side should parse or infer the other's source.
