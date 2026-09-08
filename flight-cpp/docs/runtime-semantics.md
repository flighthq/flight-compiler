# Runtime semantics

The runtime exists where C++ standard-library behavior is observably different from TypeScript. Wrappers are justified by semantics, not by a desire to reproduce JavaScript method names.

## Initial invariants

- `Array<T>` and `Map<K, V>` are reference values. Copying a wrapper preserves backing identity; `clone()` explicitly creates new storage.
- `Array<T>::at` and `Map<K, V>::get` return absence rather than throwing for a missing index or key.
- Array inclusion and map key identity use SameValueZero: NaN equals NaN and positive and negative zero are the same value.
- Map iteration retains insertion order. Updating an existing key does not move it.
- `Undefined`, `Null`, and `Presence<T>` keep the two TypeScript sentinels distinct from one another and from an ordinary value.
- `Task<T>` is copyable and shares one coroutine result. A completed task can be awaited repeatedly, and the original exception is rethrown unchanged.
- `Date` applies ECMAScript-style finite millisecond clipping and stores an epoch instant. The initial calendar projection is UTC-only and is limited to the range represented by C++20 `std::chrono::year`; local-zone `getFullYear` behavior is not yet claimed.

## Deliberate gaps

The initial task runs eagerly on the invoking thread and supports coroutine return/await of already-settled tasks, ready/reject construction, ordered `join_all`, exception propagation, and `void`. Awaiting a pending task fails explicitly because there is no executor to resume it yet. It does not claim the compiler's full `flight-runtime-task-capability-abi/1`: executor construction, assimilating resolution, `then`, `catch`, `finally`, event-loop scheduling, cancellation, and externally suspended work still require an executor model and direct tests.

`Array<T>` currently requires copyable elements for operations that return copied values. `Map<K, V>` uses an ordered linear store to make identity and order correct before optimization; a later index must preserve those results exactly. Object keys will need an explicit reference-identity trait rather than accidental value equality.

Strings need an encoding decision before implementation. TypeScript indexes and reports lengths in UTF-16 code units, while C++ ecosystems commonly exchange UTF-8. The runtime must state which boundary converts and test unpaired surrogates, normalization non-equivalence, slicing, case conversion, and host I/O before the compiler elects it.

Capability status in `flight/contract.hpp` is machine-readable but intentionally coarse during incubation. `initial` means an implementation and local semantic tests exist; it does not mean the backend as a whole is production-ready.
