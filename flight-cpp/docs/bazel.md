# Bazel build

`flight-cpp` is a self-contained Bazel module as well as a CMake project. The Bazel graph builds only files below this directory and has no external module, runtime, or test dependencies. Bazelisk reads [`.bazelversion`](../.bazelversion) to select Bazel 9.2.0.

## Local build and tests

The public targets corresponding to CMake's `Flight::Cpp` and `Flight::C` are `//:cpp` and `//:c`. Compatibility aliases `//:flight_cpp` and `//:flight_cpp_c` are also public.

Bazel C++ toolchains do not expose a portable target attribute for selecting a language dialect. The checked-in targets therefore contain no compiler-specific options. For the usual GCC or Clang toolchain on Linux or macOS, run:

```sh
cd flight-cpp
bazel build --config=local-posix //:cpp //:c
bazel test --config=local-posix //:tests
```

For the Visual C++ toolchain, replace `local-posix` with `local-msvc`. Both named configurations select C++20. A registered toolchain that already selects C++20 needs neither local configuration.

`//:tests` covers the runtime, compiler-generated source, C ABI, all public headers in isolation, and C and C++ public-surface consumers. The underlying labels are available for focused runs:

- `//tests:runtime_test`
- `//tests:runtime_conformance_test`
- `//tests:generated_runtime_test`
- `//tests:c_api_test`
- `//tests:c_api_thread_test`
- `//tests:public_header_tests`
- `//tests/consumer:cpp_consumer_test`
- `//tests/consumer:c_consumer_test`

The performance smoke test is intentionally excluded from wildcard and suite runs by its `manual` tag. Run it explicitly in an optimized configuration:

```sh
bazel test --config=local-posix --config=release //benchmarks:runtime_benchmark
```

## Registered toolchains and platforms

Production and cross builds should make the C++20 dialect, compiler, standard library, sysroot, linker, and target constraints part of a registered C++ toolchain. Select that toolchain through the normal Bazel resolution surface:

```sh
bazel test //:tests \
  --platforms=@company_platforms//cpp:linux_x86_64 \
  --extra_toolchains=@company_toolchains//cpp:clang_linux_x86_64
```

The target graph does not inspect the machine operating system or compiler and does not inject GCC, Clang, or MSVC flags. Consequently the same labels work with local, cross, containerized, and remote-execution toolchains. Put personal defaults in the ignored `.bazelrc.local`; checked-in automation should pass platform and toolchain labels explicitly.

`//:c` is a linked static C ABI library. The Bazel graph does not yet force a shared-library artifact: a correct portable shared target must give the adapter private export definitions and its consumers public import definitions, then be tested across ELF, Mach-O, and PE/COFF. An ad hoc `cc_binary(linkshared=True)` would not meet that contract on Visual C++. Until that split exists, use the CMake `BUILD_SHARED_LIBS` build when a loadable C ABI artifact is required.

## Reproducibility policy

The module pins its Bazel release, contains an explicit source graph, disables build stamping, and gives tests a fixed UTC/C process environment. Strict action environments keep undeclared machine state out of compile and link actions. Release builds use `--config=release`; CI can add `--config=ci` to retain all failures from a test sweep.

The current module declares no `bazel_dep`, module extension, archive, or Git repository, so there is no external dependency graph to lock or fetch. If an external build dependency is introduced, its version and integrity must be pinned in `MODULE.bazel`, the Bazel 9.2.0-generated `MODULE.bazel.lock` must be committed, and CI must resolve it with `--lockfile_mode=error` before the change is production-ready. A consuming repository owns its own module lock and may substitute its registered platforms and toolchains without changing `flight-cpp`.

Bazel cache keys include the selected platform and toolchain. Reproducibility therefore means identical outputs for identical source, Bazel, flags, platform, and toolchain inputs; it does not assert byte equality between different C++ compilers or standard libraries.
