# flight-cpp

`flight-cpp` is the incubating C++20 runtime for TypeScript compiled by Flight Compiler. It lives in the compiler repository while the generated-code boundary is still changing quickly, but it is deliberately an independent CMake project so it can move to its own repository without a build-system migration.

This is a working foundation, not a production-support claim. Version 0.1.0 provides tested representations for shared arrays, insertion-ordered maps and sets, typed-array views, explicit `undefined`/`null` presence, SameValueZero equality, UTF-16 strings, UTC date instants, and shared coroutine tasks. Tasks use an explicit non-reentrant executor and implement first-settlement-wins construction, exact rejection values, queued continuation, recovery, cleanup, assimilation, and ordered aggregation. Full Unicode case conversion is supplied through a host service. Compiler-generated conformance now exercises collections, strings, typed arrays, and coroutines; cancellation and time zones remain open.

## Build

The project has no third-party runtime or test dependencies:

```sh
cmake -S . -B build -DBUILD_TESTING=ON
cmake --build build
ctest --test-dir build --output-on-failure
```

GCC and Clang development builds can add `-DFLIGHT_CPP_ENABLE_SANITIZERS=ON` to run the same runtime and generated-program tests under AddressSanitizer and UndefinedBehaviorSanitizer.

Consumers can build it in-tree with `add_subdirectory`, or install it and use:

```cmake
find_package(FlightCpp 0.1 CONFIG REQUIRED)
target_link_libraries(my_program PRIVATE Flight::Cpp)
```

The runtime is header-only during incubation. Include the complete compatibility surface with:

```cpp
#include <flight/runtime.hpp>
```

The umbrella header provides `FlightTask<T>` and `FlightDate` compatibility names. The compiler's `flight-cpp` runtime profile emits the namespaced semantic APIs directly.

## Boundary

The installed `flight/` headers and `Flight::Cpp` target are the extraction boundary. Nothing in this directory imports the compiler, assumes its repository layout, participates in the npm workspace, or relies on generated source checked in elsewhere.

The compiler emits semantic runtime types such as `flight::Array<T>` and `flight::Map<K, V>` when `runtimeProfile: "flight-cpp"` is elected. The separate `standard-library` profile preserves generic provisional output without claiming TypeScript-equivalent collection behavior. See [compiler integration](docs/compiler-integration.md) and [runtime semantics](docs/runtime-semantics.md).

The root repository license applies while this project is incubated here.
