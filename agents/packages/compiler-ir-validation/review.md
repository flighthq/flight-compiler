---
package: '@flighthq/compiler-ir-validation'
status: near-mature
score: 86
updated: 2026-08-21
ingested:
  - source
  - agents/compiler-foundations.md
---

# compiler-ir-validation — Review

The dependency-floor integrity boundary for in-process target-neutral IR values produced by semantic lowering, patches, and lowering passes.

## Verdict

**near-mature — 86/100.** The validator is exhaustive over every current IR family, deterministic, non-mutating, and strict about module identity, declaration and binding source provenance, introduction-site legality, lexical reachability, exact SHA-256 fingerprints, compound-type arity, and parameter cardinality. Its scope graph distinguishes module, declaration, function, and block ownership: closures and function-hoisted variables remain valid, while sibling-function, sibling-block, escaped catch, and escaped loop references fail with a stable code. Lowering applies validation before pass-specific postconditions, so a pass cannot disguise corrupt provenance as valid output. The package deliberately validates structure rather than claiming semantic equivalence between an input and transformed output.

## What a fully expressed IR validator looks like

- A compiler-checked exhaustive walk over every declaration, export, expression, object member, statement, and type family. Present.
- Stable inspectable failure codes and precise structural paths rather than message-driven control flow. Present.
- Binding introductions carry exact source fingerprints, are unique, occur at a legal space/kind/scope site, and every bound reference resolves to consistent immutable metadata in an ancestor lexical region. Preferred names may change at an introduction without rewriting stable-ID references. Present within one module.
- Runtime cardinality checks for invariants expressed statically by tuple contracts. Present for compound types, executable/function parameters, and tuple elements.
- No target syntax, target policy, filesystem access, TypeScript checker dependency, or mutation. Present.
- Cross-module import/export binding validation and semantic before/after preservation checks.

- **Control-flow labels are validated, not merely carried.** The walk maintains a label stack distinguishing continuable from non-continuable targets, checks each label's source origin, and rejects a `break`/`continue` whose target is not an enclosing label. The vocabulary arrived and the validator covers it in the same batch, which is the order this package should always be in.
- **The binding-pattern and tuple families are covered as they land.** Array and object patterns, tuple suffixes and residual value plans each validate structurally, so the neutral pass library cannot hand a half-normalized pattern to a backend and have it read as valid.

## Ownership boundary

`compiler-types` owns the IR vocabulary. This package answers whether an in-memory module conforms to its structural and lexical invariants. A lowering pass continues to own its transformation-specific postcondition; orchestration and downstream targets own no competing structural validator. Lexical regions remain an implementation detail of this exhaustive walk: no second package is justified until another consumer needs a stable scope-analysis contract rather than its own target namespace.

## Gaps

- Imports are structurally introduced, but their referenced declaration in another module is not validated.
- A structurally valid transform can still drop or reorder executable behavior. Pass-specific semantic verification remains necessary.
- Textual use-before-declaration and temporal-dead-zone behavior are not rejected. Neutral IR is binding-based rather than SSA, and structurally valid JavaScript includes hoisted declarations and references whose initialization behavior is decided at execution time.
- There is no untyped serialized-IR parser. The defensive shape failure exists for pass output; it is not a substitute for a future document boundary.
