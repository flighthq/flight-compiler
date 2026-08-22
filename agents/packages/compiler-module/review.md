---
package: '@flighthq/compiler-module'
status: early
score: 55
updated: 2026-08-22
ingested:
  - source
  - agents/compiler-foundations.md
  - handoff parcel builder-5e1b1bca (facade work, not yet on this base)
---

# compiler-module — Review

Target-neutral module linking and evaluation: which modules depend on which, in what order they evaluate, and which public slot a name refers to. ~680 lines and 6 tests **on this base**; the facade half is landed in a parcel that has not merged here yet, and is reviewed separately below.

## Verdict

**early — 55/100.** Evaluation semantics are the correct floor and they are modelled carefully: link dependencies are separated from runtime evaluation edges, so a type-only import links without scheduling anything, and cycles retain a deterministic strongly-connected-component order rather than being refused or arbitrarily broken. The domain is early because everything a target does _with_ a module — the facade — is either in flight or absent, and because six tests is thin for a package whose failure mode is a silently wrong evaluation order.

## What a fully expressed module domain looks like

- Complete link dependencies separated from runtime evaluation edges, so type-only imports do not schedule evaluation. Present.
- Deterministic evaluation order including cycles, matching the source language's own rule. Present.
- Public slot identity independent of the route that satisfies it. Present in the landed facade work.
- Facade resolution through local bindings, default expressions, import aliases, and named, namespace and star re-exports, across chains and cycles. Present in the landed facade work.
- Explicit-over-star precedence, `default` excluded from stars, identical diamonds coalesced, distinct star resolutions refused as ambiguous. Present in the landed facade work.
- Live-binding semantics: a re-exported binding observes later mutation of its source. Modelled; unproven downstream.
- Temporal dead zone and access-before-evaluation as named failures rather than emitted hazards.
- A target facade representation. **Absent** — both backends refuse.

## Present capabilities

- **Type-only edges link without evaluating.** This is the distinction that stops a type-only import from forcing a module to run, and it is modelled at the contract level rather than filtered late.
- **Cycles keep a deterministic order.** Runtime strongly-connected-component ordering is retained rather than refused, which is what the source language actually does.
- **Ten tagged failure codes** covering duplicate and missing dependencies, duplicate modules, entries and bindings, invalid declaration kinds, and `unsupported-default-expression-order`.
- **Facade identity moved to its domain owner.** It previously lived in `compiler-emission`; module identity belongs with module semantics, and emission should not own what a public slot is.

## Gaps

- **No target facade representation.** Both backends refuse anything beyond direct declaration reflection. This is the next iteration and it is the only thing standing between the neutral plan and emitted re-exports.
- **The requirement predicate is a boolean.** `hasCompilerModuleFacadeLoweringRequirement` answers whether a module needs facade lowering but not which export or why, so both backends emit a message naming two causes when the predicate has at least four — a renamed local export, a type-only disagreement, a missing declaration, and genuine re-exports. Recorded as the first follow-up.
- **Six tests over evaluation ordering.** Order is the one output here whose wrongness is invisible: a plausible order that is not the source language's order produces working-looking code with different side-effect timing. Cycle shapes, diamond shapes and type-only-edge counterexamples deserve more counterexamples than equivalence cases.
- **No temporal-dead-zone failures yet.** Access before evaluation is named as a domain concern in the workspace layout but is not a tagged failure here.
- **Live bindings are modelled and unproven.** Nothing downstream observes a re-exported binding changing after evaluation, so the semantics are stated rather than exercised.
