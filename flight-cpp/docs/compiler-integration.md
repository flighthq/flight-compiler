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

Remaining graduation work is intentionally narrow: remove the exception ledger through neutral union/capture evidence, select production Unicode and time-zone providers, prove a supported 32-bit configuration, and hold performance/ABI compatibility gates over at least one release-candidate cycle.

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
