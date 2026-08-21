---
package: '@flighthq/compiler-ordering'
status: near-mature
score: 90
updated: 2026-08-20
ingested:
  - source
  - agents/compiler-foundations.md
---

# compiler-ordering — Review

The dependency-free owner of host-independent ordering primitives used in deterministic compiler output.

## Verdict

**near-mature — 90/100.** The domain is intentionally tiny: one comparator defines exact UTF-16 code-unit order for compiler text. Equality, empty and prefix values, ASCII case, non-ASCII and surrogate text, antisymmetry, transitivity, and the separation between ordering and Unicode normalization are direct-tested. Its remaining work can only be justified by another repeated ordering domain.

## What a fully expressed compiler ordering package looks like

- One exact total order whose result does not depend on host locale, process configuration, or input order. Present for text.
- Equality returns zero; lower and higher values return stable negative and positive values. Present as the narrow `-1 | 0 | 1` result.
- Comparator laws are executable specifications rather than assumptions made by callers. Present for representative compiler text.
- Ordering does not silently normalize identities. Present; callers choose normalization before comparison when their domain requires it.
- No compiler contracts, filesystem, parser, target, or mutable global state. Present.

## Ownership boundary

This package compares already-decided text identities. It does not decide whether two paths, source nodes, target names, or external types are equivalent; the package that owns that identity normalizes first and then uses this order. Composite record precedence remains with the domain package that understands the fields.

## Present adoption

Patch precedence and audits, emitted-name allocation, runtime-contract requirements, inventory facts and reports, and orchestration modules, diagnostics, and files all use this primitive. Package health rejects local named text comparators outside this workspace and rejects locale-sensitive `localeCompare` throughout package source.

## Gaps

- Only text ordering is shared. Add another primitive only after multiple packages demonstrate the same non-text order and laws.
- UTF-16 code-unit order is portable and exact, not human-natural. User-facing presentation that needs locale-aware collation is a different, explicitly environmental concern and must not drive deterministic compiler artifacts.
