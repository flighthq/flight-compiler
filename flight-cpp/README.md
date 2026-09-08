# flight-cpp

`flight-cpp` is the incubating C++20 runtime for TypeScript compiled by Flight Compiler. It lives in the compiler repository while the generated-code boundary is still changing quickly, but it is deliberately an independent CMake project so it can move to its own repository without a build-system migration.

This is a working foundation, not yet a production-support claim. Version 0.1.0 provides tested representations for shared arrays, insertion-ordered maps and sets, typed-array views, explicit `undefined`/`null` presence, SameValueZero equality, UTF-16 strings, source-style errors and number formatting, UTC date instants, and shared coroutine tasks. Tasks use an explicit non-reentrant executor and implement first-settlement-wins construction, exact rejection values, queued continuation, recovery, cleanup, assimilation, and ordered aggregation. Full Unicode case conversion is supplied through a host service. Compiler-generated conformance exercises collections, strings, classes, typed arrays, optional access, and coroutines; cancellation, time zones, captured mutation, and multi-member union access remain open.

## Build

The project has no third-party runtime or test dependencies:

```sh
cmake -S . -B build -DBUILD_TESTING=ON
cmake --build build
ctest --test-dir build --output-on-failure
```

GCC and Clang development builds can add `-DFLIGHT_CPP_ENABLE_SANITIZERS=ON` to run the same runtime and generated-program tests under AddressSanitizer and UndefinedBehaviorSanitizer.

Release builds can add `-DFLIGHT_CPP_BUILD_BENCHMARKS=ON`. The resulting `flight_cpp.performance` CTest emits JSON-lines measurements and applies deliberately broad throughput floors for collection, ordered-map, and settled-task regressions. These are smoke gates, not cross-machine comparisons; release-candidate history should tighten them only after a stable runner baseline exists.

Consumers can build it in-tree with `add_subdirectory`, or install it and use:

```cmake
find_package(FlightCpp 0.1 CONFIG REQUIRED)
target_link_libraries(my_program PRIVATE Flight::Cpp)
```

Foreign-language consumers can link `Flight::C` and include `<flight/c/runtime.h>`. The initial ABI exposes version negotiation and reference-counted UTF-8 string handles without leaking C++ layout or exceptions. It is intentionally smaller than the C++ surface; bindings add functions only after their ownership, error, and threading rules are fixed. The [C ABI contract](docs/c-api.md) defines those rules, and the [ABI v1 contract snapshot](abi/c-api-v1.txt) makes function-signature and status-value drift explicit in repository checks.

The C++ semantic runtime remains header-only during incubation; `Flight::C` is its separately linked ABI adapter. Include the complete C++ compatibility surface with:

```cpp
#include <flight/runtime.hpp>
```

The umbrella header provides `FlightTask<T>` and `FlightDate` compatibility names. The compiler's `flight-cpp` runtime profile emits the namespaced semantic APIs directly.

Native hosts configure executor and Unicode policy together with `flight::HostScope`. Services are thread-scoped and nest safely, which gives an embedder an explicit boundary instead of process-global callbacks.

## Boundary

The installed `flight/` headers and `Flight::Cpp` target are the extraction boundary. Nothing in this directory imports the compiler, assumes its repository layout, participates in the npm workspace, or relies on generated source checked in elsewhere.

The compiler emits semantic runtime types such as `flight::Array<T>` and `flight::Map<K, V>` when `runtimeProfile: "flight-cpp"` is elected. The separate `standard-library` profile preserves generic provisional output without claiming TypeScript-equivalent collection behavior. See [compiler integration](docs/compiler-integration.md) and [runtime semantics](docs/runtime-semantics.md).

The supported input boundary is versioned as [`flight-portable-typescript/1`](conformance/portable-typescript-v1.json). [`known-exceptions.json`](conformance/known-exceptions.json) owns every checked-in C++ refusal and is verified by `npm run cpp:exceptions:check`; an exception that starts emitting or changes its rule fails the gate until the ledger is deliberately updated. See [production readiness](docs/production-readiness.md) for proof and release policy.

The root repository license applies while this project is incubated here.
