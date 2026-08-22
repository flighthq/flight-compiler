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

## Gaps

- The capability vocabulary now contains only names a backend actually binds. `callback`, `symbol` and `host-value` were declared and elected by nothing; a capability no target binds cannot distinguish "unsupported" from "merely unmet", so they were removed rather than left as aspirational vocabulary. Returning one is a union member plus a binding-table entry, which is the right price for a demonstrated target path.
- A missing decision names the exact symbol and space but not the modules or declarations that made it reachable.
- The in-process typed plan has no untyped document parser or tagged invalid-document failure; add that only if plans cross a serialization boundary.
- Target tables state the compiler election, not whether a particular downstream runtime release implements the elected contract version; that compatibility handshake belongs at integration time.

## Ownership boundary

This package owns source-side reachability and plan completeness. `compiler-types` owns the shared contract vocabulary. Each backend owns its election table and emitted target names. `flight-hx` and `flight-rs` own runtime types and behavior satisfying elected capabilities.
