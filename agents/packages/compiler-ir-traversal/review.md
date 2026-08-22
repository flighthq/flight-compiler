---
package: '@flighthq/compiler-ir-traversal'
status: near-mature
score: 82
updated: 2026-08-22
ingested:
  - source
  - agents/compiler-foundations.md
---

# compiler-ir-traversal — Review

The one typed structural walk over an `IrModule`. ~650 lines across the traversal and a path primitive, 11 tests. Its purpose is that every other package stops writing its own walk.

## Verdict

**near-mature — 82/100.** A small domain, nearly all of it expressed. The walk is exhaustive by compile-time construction, the observer contract covers every family the walk descends into, and an observer can stop the traversal without unwinding the whole module. What keeps it below the canonical-form tier is that adoption is still partial — several packages continue to hand-roll walks the traversal could serve — and that observation is the only mode: nothing here rewrites.

## What a fully expressed IR traversal looks like

- One walk that visits every node family, with a new IR kind becoming a compile error rather than a silent omission. Present, through `assertNeverIrTraversal` on every discriminated switch.
- An observer contract no narrower than the walk itself, so no consumer has to re-implement it for one missing hook. Present: twelve hooks against eleven traversal functions plus the module root.
- Early termination, so a presence question costs the prefix rather than the whole module. Present, through a module-private stop symbol thrown by the observer wrapper and caught only at the entry point.
- Stable node addressing, so a consumer can name where it is rather than only what it saw. Present, through `CompilerIrTraversalPath` and `getIrModuleTraversalPathValue`.
- No policy: no validation, no analysis, no target knowledge, no mutation. Present.
- A rewriting counterpart for transforms that need one, or a recorded decision that transforms own their own recursion.

## Present capabilities

- **Compile-time exhaustiveness.** Every `switch` over a discriminated IR union ends in `assertNeverIrTraversal(value: never)`, so adding an expression, statement, type or member kind fails to compile until the walk handles it. This is the guarantee the earlier void-returning switches did not carry, and it is the whole reason a shared walk is safer than five private ones.
- **The contract matches the walk.** `bindingPattern`, `declaration`, `expression`, `functionSignature`, `module`, `objectMember`, `optionalChain`, `parameter`, `statement`, `type`, `typeParameter`, `variable`. Nothing is descended into that cannot be observed.
- **Early exit that cannot be forged or swallowed.** `observeIrTraversalValue` throws a private `Symbol` when an observer returns `false`; `analyzeIrModuleTraversal` catches it and rethrows anything else. A caller cannot fabricate the signal and a genuine error cannot be mistaken for one.
- **Path addressing.** Traversal paths give a consumer a stable address for a node, which is what lets closure evidence and the async state machine report _where_ rather than only _what_.
- **Real adoption at the point it was written for.** The binding-pattern composite's residual counter was an untyped reflective walk keyed on a property named `pattern`; it is now a typed observer, which also corrected the count to include rest patterns.

## Gaps

- **Adoption is partial.** `compiler-ir-validation`, the lowering passes' presence checks, and the runtime-contract reachability walk each still recurse independently. Every one of those is a place a new IR kind can be silently skipped — the exact hazard this package exists to remove. Converting them is the work that turns this package from available into load-bearing.
- **Observation only.** There is no rewriting traversal, so every transform in `compiler-lowering` writes its own recursion, and those recursions are where a new IR kind goes unhandled. Either a mapping counterpart or a recorded decision that transforms own their recursion would close the question; leaving it unstated means each new pass re-decides it.
- **No sibling or ancestor context.** An observer sees a node and its path but not its parent node, so a consumer needing "the statement containing this expression" reconstructs it from the path or keeps its own stack.
- **Traversal order is not documented as a contract.** Consumers that accumulate ordered evidence — closure origins, completion paths — depend on it. It is deterministic in practice; it is not stated, so a future reordering would be invisible until downstream output moved.
