---
package: '@flighthq/compiler-backend-rs'
status: early
score: 62
updated: 2026-08-21
ingested:
  - source
  - agents/compiler-migration-roadmap.md
  - golden/
---

# compiler-backend-rs — Review

Rust lowering, naming and source emission: ~1,410 lines across the emitter, the identity primitive and the ambient-symbol binding table. 77 tests. Rust follows Haxe over the same neutral IR, and it is the harder target because ownership, borrowing and exhaustive matching have no counterpart in the source language.

## Verdict

**solid — 62/100.** The largest single-batch movement in the repository: optional chains now project through `as_ref().map(...)`/`and_then(...)` instead of refusing, nullable parameters emit as `Option<T>` rather than being turned away at the door, switch statements emit, labeled loops emit with real Rust labels, fixed tuples project and spread, and object-key iteration emits when the key set is closed evidence rather than a guess. Its refusal surface is still the broadest in the repository — around thirty-eight named refusals — and that remains the package working as designed. The score moves eight points and no further because the thing that makes a Rust backend a Rust backend is still absent: there is no ownership model, and every gain above is a gain in _what can be expressed_, not in _how values are owned_.

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
- **Explicit ambient-symbol election.** A versioned table independently maps type and value-space collections and typed arrays to native Rust representations, routes `Promise` through the downstream task capability, and rejects every unknown ambient symbol before target-name allocation. Constructors use elected type paths and static members use Rust associated-item syntax.
- **Correct `panic!` formatting.** `panic!("{:?}", …)` — the earlier over-escaped `"{{:?}}"` form was a hard compile error on every `throw`.
- **Optional chains as Option projections.** An optional property, element or call emits `receiver.as_ref().map(...)` or `.and_then(...)` over a bound `optional_chain_value`, so the chain short-circuits the way the source does. Each form refuses when the neutral optional-chain evidence is missing, so the projection is never guessed from syntax alone.
- **Nullable parameters emit.** A parameter whose neutral type is nullable becomes `Option<T>`; what still refuses is an _observable undefined_ entry value, which needs a nullable Rust type domain rather than an Option wrapper.
- **Switch emits, labels emit.** A switch binds its subject once and emits its cases against that binding; labeled `loop`/`while`/block emit real Rust labels, and `break`/`continue` carry their target. This is one of the few places where a Rust construct is a closer fit for the source than the Haxe one, and it is exploited rather than flattened.
- **Closed-evidence object iteration.** `for (const k in o)` emits only when the neutral key plan is closed evidence; an open key set, an effectful subject, or a computed rest each refuse by name rather than iterating a guess.
- **Destructuring arrives lowered.** Residual binding patterns refuse with "requires destructuring lowering before Rust emission", keeping pattern normalization in the neutral pass library.
- **Golden-pinned output and refusals**, including the name-collision refusal and the nullability refusals.

## Gaps

- **No ownership model at all.** Every non-static method takes `&mut self` regardless of what it does; parameters are taken by value; nothing derives ownership from the neutral aliasing facts. This is the domain, and it is unstarted.
- **No borrow-awareness.** Nothing prevents the emitter from producing code the borrow checker rejects; correctness rests entirely on the narrowness of what is currently lowerable.
- **Classes barely exist.** Field initializers, constructors, static fields, inheritance and abstract classes all refuse. A struct with no constructor and no initializers is the only lowerable class shape.
- **No task lowering.** Async functions, methods, closures, `await` and async iteration all refuse; `FlightTask` is named in the type table but nothing produces one.
- **No error lowering.** `throw` becomes `panic!`, uniformly, with no `Result` path — so a recoverable upstream error becomes an abort.
- **`try`/`catch`/`finally` refuses entirely.**
- **Switch emits as a bound-subject case chain, not as `match`.** That is sound for a non-exhaustive source switch, but it leaves Rust's exhaustiveness checking — one of the target's strongest correctness tools — entirely unused. A `match` path for the shapes that are provably exhaustive is a real gap, not a stylistic one.
- **Non-nullable unions, intersections, anonymous object types and construction, `Partial<T>` and default parameters all refuse.** Object-key iteration no longer belongs on this list; spread calls into default parameters now refuse specifically, naming ABI expansion as the missing work.
- **Integer width is unmodelled.** Every numeric is `f64`; array indices are cast `as usize` at use. Rust's integer types are where a large part of target correctness lives.
- **Callback, opaque-host, and primitive-symbol requirements are not completeness-checked.** Their neutral capability names exist, but no demonstrated target path yet supplies a stable requirement identity for them.
- **No output verification and no byte-parity harness** against `flight-rs`, same as the Haxe backend.

## An indexing-semantics gap, recorded 2026-08-22

`values[index]` emits as `values[index as usize]`, which **panics** when the index is out of range. The source language returns `undefined` there, which is why `values[index] ?? 0` is ordinary code. So the emitted program aborts where the source would take the fallback.

Faithful lowering means an element access produces an `Option` — `values.get(index as usize).copied()` — and every consumer then handles the absent case. That is invasive rather than difficult: it changes the type of every indexed read, and the neutral IR already distinguishes the two through the source's own `noUncheckedIndexedAccess` typing.

Until it is done, `??` over an indexed read refuses rather than emitting a coalesce over a value that cannot be absent, which at least keeps the wrong program from being emitted quietly.

Since the last score the Rust backend gained a working ownership story at the seams that matter: borrowed parameters where the source mutates through, clones where a value would otherwise be moved out from under a later use, `Some` entering an `Option` and a borrow rather than a move opening one, and an ambient member table whose iterator shapes are the difference between a rename and a lowering. Every emitted fixture compiles under rustc 1.98 with only source-mirroring warnings. Representation is still the gap: nothing decides between owning, borrowing, and sharing beyond these seams.
