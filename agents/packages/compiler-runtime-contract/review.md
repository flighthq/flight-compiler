---
package: '@flighthq/compiler-runtime-contract'
status: near-mature
score: 86
updated: 2026-08-21
ingested:
  - source
  - agents/compiler-foundations.md
---

# compiler-runtime-contract — Review

The target-neutral seam that identifies reachable ambient source symbols and proves that a target has made exactly one native-or-runtime decision for each required type/value-space identity.

## Verdict

**near-mature — 86/100.** `flight-runtime-contract/2` closes the false equivalence between a source type and its runtime value. Reachability is exhaustive over the current IR, includes constructors, static members, direct values and `typeof` queries, excludes lexical bindings and declared intrinsics, and normalizes exact source identity before locale-independent ordering. Completeness independently reports every missing and duplicate type/value decision; mutation kills every generated contract mutant. Remaining work needs new requirement families or diagnostic evidence, not more branches in the ambient-symbol model.

## Present capabilities

- Exact `{ sourceName, space }` identity keeps `Promise[type]` distinct from `Promise[value]`.
- A versioned native-or-runtime election records a compiler-owned capability only where a downstream implementation is required.
- Complete declaration, expression, statement, object-member and type traversal collects both ambient spaces without importing target policy.
- Lexical bindings, including shorthand object values, remain binding identities rather than false ambient requirements; `undefined` and utility type wrappers remain declared compiler intrinsics.
- NFC normalization, shared code-unit ordering, deduplication, empty identity behavior and caller immutability are direct-tested.
- Missing-only, duplicate-only and mixed incompleteness are independently observable.
- Haxe and Rust tables remain backend-owned data, while runtime implementations remain in `flight-hx` and `flight-rs`.

## Binding identity is symbol-level, and two corpus gaps are not

Measured against the corpus on 2026-08-22. Two ambient symbols the golden fixtures reach are still unbound, and neither is a missing table row:

- **`Date`** is unbound on purpose. `runtimeExternalTypeMissing` exists to prove the completeness gate fires, so binding it would delete the only test that the gate works. The gap is the fixture's subject, not a defect.
- **`Math`** cannot be expressed by the current binding shape. A binding maps `{sourceName, space}` to one target name, which fits `Array` to `Vec` or `Promise` to a task capability. `Math` has no single target in Rust: `Math.max` is `f64::max` and `Math.PI` is `std::f64::consts::PI`, so the mapping is per member rather than per symbol. Haxe binds `Math` natively only because Haxe happens to have a `Math` class with the same member names — an accident of that target, not a general answer.

So the contract has a shape gap rather than a coverage gap: it can say _which_ symbol a target provides but not _how each member of one_ is spelled. Adding member-level identity is the change that would let a namespace-like ambient symbol bind at all, and it is worth deciding before more symbols arrive and each backend invents its own member table.

## Gaps

- The capability vocabulary now contains only names a backend actually binds. `callback`, `symbol` and `host-value` were declared and elected by nothing; a capability no target binds cannot distinguish "unsupported" from "merely unmet", so they were removed rather than left as aspirational vocabulary. Returning one is a union member plus a binding-table entry, which is the right price for a demonstrated target path.
- A missing decision names the exact symbol and space but not the modules or declarations that made it reachable.
- The in-process typed plan has no untyped document parser or tagged invalid-document failure; add that only if plans cross a serialization boundary.
- Target tables state the compiler election, not whether a particular downstream runtime release implements the elected contract version; that compatibility handshake belongs at integration time.

## Ownership boundary

This package owns source-side reachability and plan completeness. `compiler-types` owns the shared contract vocabulary. Each backend owns its election table and emitted target names. `flight-hx` and `flight-rs` own runtime types and behavior satisfying elected capabilities.
