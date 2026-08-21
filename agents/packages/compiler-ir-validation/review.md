---
package: '@flighthq/compiler-ir-validation'
status: solid
score: 69
updated: 2026-08-20
ingested:
  - source
  - agents/compiler-foundations.md
---

# compiler-ir-validation — Review

The dependency-floor integrity boundary for in-process target-neutral IR values produced by semantic lowering, patches, and lowering passes.

## Verdict

**solid — 69/100.** The initial validator is exhaustive over every current IR family, deterministic, non-mutating, and strict about module identity, binding introduction/reference consistency, source provenance, compound-type arity, and parameter cardinality. It deliberately validates structure rather than claiming semantic equivalence between an input and transformed output.

## What a fully expressed IR validator looks like

- A compiler-checked exhaustive walk over every declaration, export, expression, object member, statement, and type family. Present.
- Stable inspectable failure codes and precise structural paths rather than message-driven control flow. Present.
- Binding introductions are unique and valid, and every bound reference resolves to consistent introduction metadata. Present within one module.
- Runtime cardinality checks for invariants expressed statically by tuple contracts. Present for compound types, executable/function parameters, and tuple elements.
- No target syntax, target policy, filesystem access, TypeScript checker dependency, or mutation. Present.
- Lexical scope validation, cross-module import/export binding validation, and semantic before/after preservation checks.

## Ownership boundary

`compiler-types` owns the IR vocabulary. This package answers whether an in-memory module conforms to its structural invariants. A lowering pass continues to own its transformation-specific postcondition; orchestration and downstream targets own no competing structural validator.

## Gaps

- Reference resolution proves module-wide introduction and metadata consistency, not lexical dominance or scope ownership.
- Imports are structurally introduced, but their referenced declaration in another module is not validated.
- A structurally valid transform can still drop or reorder executable behavior. Pass-specific semantic verification remains necessary.
- There is no untyped serialized-IR parser. The defensive shape failure exists for pass output; it is not a substitute for a future document boundary.
