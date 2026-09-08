# C ABI

`<flight/c/runtime.h>` is valid C11 and C++. Link the installed `Flight::C` target. Its exported names carry the `flight_cpp_` prefix and its ABI number is the same `runtime_contract.cpp_abi` used by generated C++.

Call `flight_cpp_abi_version()` before using a dynamically loaded runtime and reject a number the binding was not generated for. `flight_cpp_version()` returns a process-lifetime, null-terminated semantic-version string; callers must not free it.

`flight_cpp_status` has the fixed width `uint32_t`; its named values are part of the ABI contract. Opaque handles have no exposed layout.

String and error values are immutable opaque handles. A successful create operation returns one owned reference. `retain` adds a reference and every reference must be balanced by `release`; releasing null is harmless. Every create operation initializes a non-null output slot to null before validation or allocation, so failure never leaves a stale handle there. UTF-8 create operations validate their input and no function permits a C++ exception to cross the ABI.

`flight_cpp_string_utf8_size` reports the exact byte count without a terminator. `flight_cpp_string_copy_utf8` always reports the required count through `written`; if capacity is insufficient it returns `FLIGHT_CPP_STATUS_BUFFER_TOO_SMALL` and writes no partial value. A zero-length value accepts a null output buffer with zero capacity.

`flight_cpp_error_create_utf8` creates the base Flight `Error` value directly. `flight_cpp_error_create` copies an existing string into an error without consuming or retaining the source handle, so the two handles have independent lifetimes. `flight_cpp_error_message` returns a new owned string containing the message. ABI status values describe whether an adapter call completed; an error handle is a Flight runtime value and is not hidden per-thread status detail.

Reference-count changes are atomic and const operations on the same immutable handle may run concurrently. Each participating thread must already own a reference, or receive one through caller-provided synchronization, before it calls the ABI. A caller must never race a new `retain` against release of the last existing reference. Handle publication, callback affinity, and synchronization around a caller's mutable handle slots remain the caller's responsibility. The adapter keeps no thread-local last-error state.

The surface is deliberately additive. New opaque value types and calls may be introduced without changing ABI 1. Removing a function, changing a status value, changing ownership, or changing a structure layout requires a new ABI number. Callback APIs will not be added until executor, thread-affinity, and cancellation behavior can be stated in this document.

`abi/c-api-v1.txt` snapshots normalized public signatures and numeric status values. `npm run cpp:abi:check` also requires a matching C-linkage definition for every declaration and selects the snapshot from `FLIGHT_CPP_ABI_VERSION`; changing the ABI number therefore requires committing a new contract snapshot.
