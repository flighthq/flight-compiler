# Compiler integration

The current C++ emitter already accepts `runtimeHeader: "flight/runtime.hpp"` and emits the compatibility names `FlightTask<T>`, `FlightDate`, and `flight::sign`. This makes task, date, and Math.sign compilation the first integration seam without coupling the two builds.

Arrays, maps, sets, and strings need a semantic lowering change before this runtime can make their emitted code valid. The current provisional bindings use `std::vector`, `std::unordered_map`, `std::unordered_set`, and `std::string`, then emit TypeScript-shaped operations those classes do not provide. Adding methods to namespace `std` would be undefined behavior and is not an acceptable bridge.

## Maturity sequence

1. Add a generated-program CMake fixture that compiles a small coroutine/date module with `flight/runtime.hpp` and runs it against TypeScript oracle values.
2. Give the C++ backend an explicit runtime election. The semantic mode should map `Array`, `Map`, `Set`, and eventually `String` to `flight` runtime types; an STL-native mode may remain only where its observable behavior has been proven equivalent.
3. Move member lowering behind type-specific capability tables. Each mapping should name return shape, absence behavior, mutation, callback convention, exception behavior, and required header rather than only a target spelling.
4. Require `flight-runtime-contract/2` completeness and a concrete C++ capability ABI at compiler orchestration time. `contract.hpp` must advertise only capabilities backed by conformance tests.
5. Compile and execute every relevant C++ golden on GCC, Clang, and MSVC. Compare results and failures with the same TypeScript fixtures used for Haxe, including aliasing, NaN, negative zero, missing values, exceptions, and module initialization.
6. Add sanitizers, 32/64-bit coverage, Debug/Release coverage, ABI compatibility checks, install/consume tests, and package provenance before calling the target production-ready.

## Planned binding changes

| TypeScript surface | Current provisional target | Semantic target |
| --- | --- | --- |
| `Promise<T>` | `FlightTask<T>` | `flight::Task<T>` through the compatibility alias until the emitter migrates |
| `Date` | `FlightDate` | `flight::Date` through the compatibility alias until the emitter migrates |
| `Array<T>` | `std::vector<T>` | `flight::Array<T>` |
| `Map<K, V>` | `std::unordered_map<K, V>` | `flight::Map<K, V>` |
| `Set<T>` | `std::unordered_set<T>` | planned `flight::Set<T>` |
| `string` | `std::string` | planned UTF-aware `flight::String` with an explicit encoding contract |

The compiler owns the decision and lowering tables. `flight-cpp` owns their maintained implementations, headers, packaging, and behavioral conformance. Neither side should parse or infer the other's source.
