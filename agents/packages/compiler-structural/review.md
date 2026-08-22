---
package: '@flighthq/compiler-structural'
status: solid
score: 72
updated: 2026-08-22
ingested:
  - source
  - agents/compiler-foundations.md
---

# compiler-structural — Review

Structural type identity and analysis above canonical form: when two object types are the same shape, when one is assignable to another, how a generic applies, and what copying a structure means. ~1,680 lines across six primitives, 39 tests.

## Verdict

**solid — 72/100.** The identity half is strong — shape identity is canonical, order-insensitive where TypeScript is and order-sensitive where it is not, with semantic counterexamples rather than only equivalence pairs. Generic substitution handles alpha-equivalence and nested shadowing. What holds the score is that the _consumers_ of this analysis are still deciding what to do with it: both backends run a structural preflight and then refuse, so the package answers questions nobody can yet act on, and the representation decisions it exists to inform — nominal storage, target copy form — are explicitly open.

## What a fully expressed structural domain looks like

- Canonical shape identity for object types, insensitive to property order and sensitive to everything that changes meaning. Present.
- Assignability with a tri-state answer, so "cannot decide yet" is distinct from "not assignable". Present.
- Generic substitution with alpha-equivalence, sequential defaults and nested shadowing. Present.
- Cross-module construction-target resolution that is deterministic and inventory-routed. Present.
- Object copy semantics as explicit data rather than an emitter assumption. Present.
- A shape inventory so a target can allocate one storage form per distinct shape. Present.
- Nominal storage election and target copy representation — how a target _renders_ the shapes this package identifies. **Absent by design, and now the blocking half.**
- Resolved operator assignability, so `+` on two structural values has an answer. Absent.

## Present capabilities

- **Shape identity that is canonical rather than textual.** Property order does not change identity; property optionality, type and count do. Duplicate properties refuse rather than silently collapsing, with a distinct code for the case that would require normalization first.
- **Tri-state assignability.** The third state is the honest one: a structural question the neutral model cannot yet decide returns "unknown" instead of a guess, which is what lets backends refuse rather than emit.
- **Substitution with real generic hygiene.** Alpha-equivalence, type application arity, sequential defaults, nested shadowing, and tagged failures for invalid plans, missing type arguments and unresolved parameter references.
- **Cross-module resolution is deterministic and routed through inventory**, so a construction target has one answer regardless of which module asked.
- **Both backends preflight through it.** `assertStructuralObjectCompatibilityHaxe` and its Rust sibling run context-wide before emission, so a structural mismatch is a named refusal at a known point rather than a malformed emission later.
- **Ten tagged failure codes**, including the two ambiguity cases — ambiguous and unresolved named construction targets — that a silent resolution would turn into a wrong-type emission.

## Gaps

- **The analysis has no renderer.** Nominal storage and target copy representation are both open, so a shape that this package identifies as one thing still has no decided form in Haxe or Rust. `shapes` remains a pinned Rust refusal.
- **Operator assignability is unresolved**, which is one of the inputs the operator-domain work in `compiler-semantic` needs to finish type-directed lowering.
- **Copy semantics are described, not elected.** `createIrObjectCopySemantics` states what a copy means neutrally; neither backend decides between value copy, reference share, or clone-on-write, and that decision is inseparable from Rust ownership.
- **Shape inventory has no stability contract.** It collects shapes across modules; nothing states whether a shape's identity is stable across compilations of a changed checkout, which is what a cached or oracle-compared artifact would need.
