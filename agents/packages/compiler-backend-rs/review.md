---
package: '@flighthq/compiler-backend-rs'
status: early
score: 26
updated: 2026-08-20
ingested:
  - source
  - agents/compiler-migration-roadmap.md
  - golden/
---

# compiler-backend-rs — Review

Rust lowering, naming and source emission: ~1,280 lines across the emitter, the identity primitive and the Rust keyword model. Rust follows Haxe over the same neutral IR, and it is the harder target because ownership, borrowing and exhaustive matching have no counterpart in the source language.

## Verdict

**early — 26/100.** Slightly behind the Haxe backend, which is the expected order and matches the roadmap's 5–10% parity estimate. Its refusal surface is the broadest in the repository — thirty-odd named refusals — and that is the package working as designed: nearly every construct that would require an ownership decision refuses rather than guessing. The identity and naming half is sound. What does not yet exist is the thing that makes a Rust backend a Rust backend: a model of ownership.

## What a fully expressed Rust backend looks like

- **An ownership model.** Every lowered value has a decided representation — owned, borrowed, shared, mutable-shared — derived from neutral aliasing and mutability facts rather than from a default. This is the whole domain; everything else is consequence.
- **A borrow-aware lowering** that produces code the borrow checker accepts: no returning references to locals, no simultaneous mutable aliases, lifetimes where they are needed.
- **A type model, not a name table.** `Option<T>`, `Result<T, E>`, `Vec<T>`, `&str` versus `String`, integer widths, and the difference between a trait object and a generic parameter each have to be chosen from the neutral type.
- **Exhaustive `match` lowering**, including a decided story for the non-exhaustive `switch` the source language allows.
- **Task lowering** for async — Rust's `async`/`await` needs an executor and a task type, which is the runtime contract's job to define and this package's to target.
- **Error lowering**: TypeScript exceptions to `Result` or panic, decided per construct rather than uniformly.
- **Module, crate and visibility layout** matching Cargo's rules, with `pub` derived from the neutral export facts.
- **A runtime contract** naming the symbols emitted code may reference (`FlightTask`, `FlightCallback`, the opaque host value), versioned against `flight-rs`.
- **Byte-stable output** matching the existing `flight-rs` generator.
- **Emission-time verification** that the output at least parses as Rust.

## Present capabilities

- **Identity and keyword safety.** `rustCompilerIdentity.ts` owns crate naming, module naming and the Rust keyword set; the emitter takes every spelling from the shared allocator. Constructor callees use type naming rather than value naming — `new Error(…)` emits `Error::new(…)`, not `error::new(…)`, which was a real defect.
- **Scope-aware constants.** Module constants are keyed by binding id, so a local or parameter that shadows a module constant keeps its own name. The earlier raw-name implementation rewrote _every_ same-named identifier to the constant, producing code that compiled and returned the wrong number — the worst class of defect the repository has had, and the one the binding-provenance work closed.
- **Public-collision refusal.** Two exported declarations whose Rust spellings normalize to one name refuse with a message naming the shared spelling, rather than silently renaming one and changing the published API. Internal collisions still rename deterministically. Pinned by a golden fixture.
- **Exact enum discriminants.** `#[repr(i32)]` enums emit integer discriminants, with out-of-range values and non-integer members refused. An earlier version emitted `A = 1.0` into a `repr(i32)` enum and `"a".to_owned()` for string enums.
- **Closed operator handling** through exhaustive records, with everything unmapped refused.
- **Structs from interfaces and object type aliases**, `Option<T>` for optional-plus-null unions, `Vec<T>` for arrays, and tuples.
- **Explicit external-type election.** A versioned table maps collections and typed arrays directly to native Rust representations, routes `Promise` through the downstream task capability, and rejects every unknown reachable ambient type before target-name allocation.
- **Correct `panic!` formatting.** `panic!("{:?}", …)` — the earlier over-escaped `"{{:?}}"` form was a hard compile error on every `throw`.
- **Golden-pinned output and refusals**, including the name-collision refusal and the nullability refusals.

## Gaps

- **No ownership model at all.** Every non-static method takes `&mut self` regardless of what it does; parameters are taken by value; nothing derives ownership from the neutral aliasing facts. This is the domain, and it is unstarted.
- **No borrow-awareness.** Nothing prevents the emitter from producing code the borrow checker rejects; correctness rests entirely on the narrowness of what is currently lowerable.
- **Classes barely exist.** Field initializers, constructors, static fields, inheritance and abstract classes all refuse. A struct with no constructor and no initializers is the only lowerable class shape.
- **No task lowering.** Async functions, methods, closures, `await` and async iteration all refuse; `FlightTask` is named in the type table but nothing produces one.
- **No error lowering.** `throw` becomes `panic!`, uniformly, with no `Result` path — so a recoverable upstream error becomes an abort.
- **`try`/`catch`/`finally` refuses entirely.**
- **No exhaustiveness story for `match`.** Switch statements refuse, correctly, because the source language's non-exhaustive switch has no sound Rust form yet.
- **Non-nullable unions, intersections, anonymous object types and construction, `Partial<T>`, object-key iteration and default parameters all refuse.**
- **Integer width is unmodelled.** Every numeric is `f64`; array indices are cast `as usize` at use. Rust's integer types are where a large part of target correctness lives.
- **Callback, opaque-host, symbol, and runtime value requirements are not completeness-checked.** Their neutral capability names now exist, but function, primitive, constructor, and static-member reachability has not yet been connected to the versioned plan.
- **No output verification and no byte-parity harness** against `flight-rs`, same as the Haxe backend.
