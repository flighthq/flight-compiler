# C ABI

`<flight/c/runtime.h>` is valid C11 and C++. Link the installed `Flight::C` target. Its exported names carry the `flight_cpp_` prefix and its ABI number is the same `runtime_contract.cpp_abi` used by generated C++.

Call `flight_cpp_abi_version()` before using a dynamically loaded runtime and reject a number the binding was not generated for. `flight_cpp_version()` returns a process-lifetime, null-terminated semantic-version string; callers must not free it.

`flight_cpp_status` has the fixed width `uint32_t`; its named values are part of the ABI contract. Opaque handles have no exposed layout.

String values are opaque handles. A successful `flight_cpp_string_create_utf8` returns one owned reference. `retain` adds a reference and every reference must be balanced by `release`; releasing null is harmless. The create operation validates UTF-8 and no function permits a C++ exception to cross the ABI.

`flight_cpp_string_utf8_size` reports the exact byte count without a terminator. `flight_cpp_string_copy_utf8` always reports the required count through `written`; if capacity is insufficient it returns `FLIGHT_CPP_STATUS_BUFFER_TOO_SMALL` and writes no partial value. A zero-length value accepts a null output buffer with zero capacity.

The surface is deliberately additive. New opaque value types and calls may be introduced without changing ABI 1. Removing a function, changing a status value, changing ownership, or changing a structure layout requires a new ABI number. Callback APIs will not be added until executor, thread-affinity, and cancellation behavior can be stated in this document.

`abi/c-api-v1.txt` snapshots normalized public signatures and numeric status values. `npm run cpp:abi:check` also requires a matching C-linkage definition for every declaration and selects the snapshot from `FLIGHT_CPP_ABI_VERSION`; changing the ABI number therefore requires committing a new contract snapshot.
