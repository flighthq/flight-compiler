# Compiler integration

The C++ backend has an explicit `runtimeProfile` election:

- `flight-cpp` maps TypeScript arrays, maps, sets, strings, typed arrays, promises, and dates to the namespaced semantic runtime and includes `<flight/runtime.hpp>` automatically.
- `standard-library` is the default compatibility profile for compiler users that do not adopt this runtime. It retains the provisional STL-oriented representation and does not claim TypeScript-equivalent collection semantics.

`runtimeHeader` overrides the automatic header spelling without changing the selected bindings, which lets an embedding codebase vendor or wrap the runtime. Adding methods to namespace `std` remains undefined behavior and is not an acceptable bridge.

The compiler owns `tests/generated/semantic_runtime.hpp`: a package test regenerates it from `semantic_runtime.ts` and refuses drift, while CMake compiles and executes it against this runtime. Run `npm run cpp:conformance:update` at the repository root after an intentional emitter change.

## Maturity sequence

1. Expand the generated fixture into the same behavioral oracle corpus used by TypeScript, Haxe, and Rust, including aliasing, NaN, negative zero, missing values, exceptions, and module initialization.
2. Enrich member capability data beyond spelling so it records return shape, absence, mutation, callback, exception, and header requirements.
3. Carry inferred constructor and generic-call result types in neutral IR so `new Promise(...)` and contextually typed empty collections do not require explicit source type arguments.
4. Add a pinned production Unicode service, time-zone policy, cancellation policy, sanitizers, 32-bit coverage, Debug/Release coverage, and ABI compatibility checks.
5. Graduate the target only after all relevant emitted programs compile and execute on GCC, Clang, AppleClang, and MSVC through both the source-tree and installed-package paths.

## Planned binding changes

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
