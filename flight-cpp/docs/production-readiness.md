# Production readiness

Production readiness is a conjunction of proofs, not the percentage of files for which an emitter returned text. `npm run readiness` reports emission coverage and `npm run readiness:json` emits the versioned `flight-compiler-readiness/1` record for automation.

That record carries the C++ profile's explicit `supportStatus`. It remains `incubating` until every pending semantic boundary below has either an implementation or a versioned restriction that downstream production consumers enforce.

The C++ lane requires all of the following for code inside `flight-portable-typescript/1`:

1. deterministic semantic-profile golden output;
2. no undeclared or stale structured refusal;
3. native compilation against the real installed header surface;
4. behavioral agreement with the TypeScript source oracle;
5. runtime and generated-program tests in Debug, Release, and sanitizer configurations;
6. source-tree and installed-package consumers on GCC, Clang, AppleClang, and MSVC;
7. stable performance and ABI reports for the release-candidate series.

The exception ledger is debt, not a waiver of those requirements. It can exclude a source construct from the portable profile while compiler or neutral-IR work is pending; it cannot turn a compile failure or behavioral divergence inside the profile green. The exception gate requires exact fixture and rule matches, so both new refusals and obsolete exceptions fail CI.

## Compatibility policy

The incubating runtime follows semantic versioning. Before 1.0, a minor version may change the C++ source ABI, but `runtime_contract.cpp_abi` must change whenever already-generated source would need a different runtime representation or call shape. Patch releases may add tests, implementations, and compatible overloads without changing that ABI.

A release candidate must keep the compiler runtime contract, C++ ABI number, CMake project version, and `flight/version.hpp` version synchronized. It must pass the cold repository sweep and the installed-consumer matrix. Extraction into a separate repository should happen only after the boundary can be copied without repository-relative includes, npm workspace dependencies, or compiler source imports; the current `flight/` installed headers and `Flight::Cpp` target already enforce that shape.

`Flight::C` is the foreign-language ABI boundary. Its opaque handles are reference counted, all functions return explicit status values, and no C++ exception or object layout crosses the header. Haxe native targets should bind this surface or a later generated extension of it; JavaScript targets should continue to use the compiler's original JavaScript output. `flight::HostScope` is the C++ embedding boundary for thread-scoped executor and Unicode services.

## Explicitly pending

- multi-member union narrowing and variant access need neutral IR evidence;
- mutable closure capture needs escape and ownership evidence;
- Unicode case conversion needs an elected production provider;
- local civil-time `Date` operations need an elected time-zone policy;
- cancellation needs a source-level contract before a runtime API is introduced;
- 32-bit support needs an available CI toolchain and an explicit supported data model.

These items prevent a production-support declaration. They do not block production use of a deliberately constrained profile after consumers run the same native and differential gates in their deployment toolchains.
