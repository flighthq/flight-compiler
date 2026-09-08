# Runtime semantics

The runtime exists where C++ standard-library behavior is observably different from TypeScript. Wrappers are justified by semantics, not by a desire to reproduce JavaScript method names.

## Initial invariants

- `Array<T>` and `Map<K, V>` are reference values. Copying a wrapper preserves backing identity; `clone()` explicitly creates new storage.
- `Array<T>::at` and `Map<K, V>::get` return absence rather than throwing for a missing index or key.
- Array inclusion and map key identity use SameValueZero: NaN equals NaN and positive and negative zero are the same value.
- Map iteration retains insertion order. Updating an existing key does not move it.
- `Undefined`, `Null`, and `Presence<T>` keep the two TypeScript sentinels distinct from one another and from an ordinary value.
- `String` stores UTF-16 code units, so length, indexing, slicing, splitting, and unpaired-surrogate behavior do not depend on the machine encoding. UTF-8 conversion is an explicit boundary.
- `Set<T>` shares Map's SameValueZero and insertion-order rules. Typed-array copies and `subarray` share a fixed backing store, while `slice` copies; clamped bytes use saturating ties-to-even conversion.
- `Task<T>` is copyable and shares one settlement. Observers run through a non-reentrant executor, completed tasks can be awaited repeatedly, and exception or non-exception rejection values retain their identity and type.
- `Date` applies ECMAScript-style finite millisecond clipping and stores an epoch instant. The initial calendar projection is UTC-only and is limited to the range represented by C++20 `std::chrono::year`; local-zone `getFullYear` behavior is not yet claimed.

## Deliberate gaps

The task runtime implements `flight-runtime-task-capability-abi/1`: synchronous executor invocation, first-call-wins settlement, task assimilation, queued `then` and rejection recovery, awaited `finally` cleanup, ordered `all`/`join_all`, coroutine suspension and resumption, exact rejection, and `void`. `QueueExecutor` provides the deterministic default and `ExecutorScope` installs a host executor while tasks are created or resumed. An executor must enqueue rather than invoke `post` reentrantly; host integrations own the event-loop wakeup and thread-affinity policy. Cancellation and structured concurrency remain separate future capabilities rather than being implied by Promise compatibility.

`Array<T>` currently requires copyable elements for operations that return copied values. `Map<K, V>` uses an ordered linear store to make identity and order correct before optimization; a later index must preserve those results exactly. Object keys will need an explicit reference-identity trait rather than accidental value equality.

String case conversion is exact for ASCII and delegates non-ASCII input to the active `UnicodeService`. The core never consults the process locale. Production hosts must provide a Unicode implementation with a pinned Unicode-data version and conformance tests for expansion, supplementary characters, Turkish casing, normalization non-equivalence, and unpaired surrogates.

Typed arrays currently model owned backing storage and overlapping views. A future `ArrayBuffer` capability must extend that storage without changing view identity, byte-offset, detachment, or endianness behavior.

Capability status in `flight/contract.hpp` is machine-readable but intentionally coarse during incubation. `initial` means an implementation and local semantic tests exist; it does not mean the backend as a whole is production-ready.
