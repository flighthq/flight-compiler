# flight-cpp

`flight-cpp` is the incubating C++20 runtime for TypeScript compiled by Flight Compiler. It lives in the compiler repository while the generated-code boundary is still changing quickly, but it is deliberately an independent CMake project so it can move to its own repository without a build-system migration.

This is a working foundation, not a production-support claim. Version 0.1.0 provides tested initial representations for shared arrays and maps, explicit `undefined`/`null` presence, SameValueZero equality, UTC date instants, and eager shared coroutine tasks. Unicode strings, sets, full Promise operations, executor scheduling, cancellation, time zones, and generated-program conformance are still open.

## Build

The project has no third-party runtime or test dependencies:

```sh
cmake -S . -B build -DBUILD_TESTING=ON
cmake --build build
ctest --test-dir build --output-on-failure
```

Consumers can build it in-tree with `add_subdirectory`, or install it and use:

```cmake
find_package(FlightCpp 0.1 CONFIG REQUIRED)
target_link_libraries(my_program PRIVATE Flight::Cpp)
```

The runtime is header-only during incubation. Include the complete compatibility surface with:

```cpp
#include <flight/runtime.hpp>
```

The umbrella header provides `FlightTask<T>` and `FlightDate`, the two global names emitted by the current C++ backend, and keeps new APIs under namespace `flight`.

## Boundary

The installed `flight/` headers and `Flight::Cpp` target are the extraction boundary. Nothing in this directory imports the compiler, assumes its repository layout, participates in the npm workspace, or relies on generated source checked in elsewhere.

The compiler should eventually emit semantic runtime types such as `flight::Array<T>` and `flight::Map<K, V>` instead of asking STL containers to behave like TypeScript objects. That migration is intentionally staged; see [compiler integration](docs/compiler-integration.md) and [runtime semantics](docs/runtime-semantics.md).

The root repository license applies while this project is incubated here.
