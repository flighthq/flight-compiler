# flight-cpp contributor contract

`flight-cpp` is an independently buildable C++20 runtime incubator. It is versioned beside the compiler only while their contract is changing quickly; do not couple it to the npm workspace, compiler implementation modules, or paths outside this directory.

The public boundary is the installed `flight/` header tree and the `Flight::Cpp` CMake target. Preserve TypeScript observable semantics over superficial resemblance to STL APIs. Reference identity, absence, equality, ordering, exceptions, and task settlement must be deliberate and directly tested.

The compatibility aliases in `flight/runtime.hpp` serve emitted code during migration. New runtime APIs belong in namespace `flight`; do not add further global names unless the compiler currently emits them.

Keep the runtime dependency-free. Build and test it from this directory with:

```sh
cmake -S . -B build -DBUILD_TESTING=ON
cmake --build build
ctest --test-dir build --output-on-failure
```

Do not claim a compiler capability or runtime ABI version in `contract.hpp` until its semantic tests exist. Document known gaps in `docs/` rather than hiding them behind permissive fallback behavior.
