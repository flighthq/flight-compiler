---
package: '@flighthq/compiler-runtime-contract'
status: solid
score: 70
updated: 2026-08-20
ingested:
  - source
  - agents/compiler-foundations.md
---

# compiler-runtime-contract — Review

The target-neutral seam that identifies reachable ambient source types and proves that a target has made exactly one native-or-runtime binding decision for each one.

## Verdict

**solid — 70/100.** The initial boundary is deliberately small and fully exercised: traversal is exhaustive over the current IR, identities are normalized before using the shared host-independent text order, caller input is unchanged, plans are versioned, and completeness names every missing or duplicate decision. The remaining domain is runtime value reachability and richer diagnostics, not more policy in this package.

## What a fully expressed runtime contract looks like

- Exact target-neutral identities for source concepts that need an emission decision. Present for ambient named types.
- An explicit, versioned election between target-native representation and a compiler-owned runtime capability. Present.
- Complete reachable-IR traversal without importing target naming or downstream runtime implementation details. Present for external types.
- Deterministic, inspectable completeness that reports every absent or ambiguous election before source generation. Present.
- Independent package health, typecheck, direct behavior tests, malformed-plan boundaries, input immutability, and zero unvisited implementation arms. Present except an untyped plan parser, which is not yet justified.
- Equivalent reachability for ambient runtime values, constructors, and static members when backends begin mapping those through the same boundary.
- Source/module evidence attached to each requirement when downstream diagnostics need more than the exact external identity.

## Ownership boundary

This package owns source-side reachability and plan completeness. `compiler-types` owns the shared contract vocabulary. Each backend owns its election table and emitted target names. `flight-hx` and `flight-rs` continue to own the runtime types and behavior that satisfy elected capabilities.

## Gaps

- Ambient value references such as constructors and static calls are outside the initial external-type contract.
- Primitive `symbol`, function callbacks, and opaque host values already have capability vocabulary but are not yet represented as completeness requirements.
- A missing binding reports exact source names but not the modules or declarations that made each type reachable.
- The in-process typed plan has no parser or tagged invalid-document failure; add those only if plans cross a serialization boundary.
