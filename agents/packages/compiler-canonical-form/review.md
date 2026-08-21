---
package: '@flighthq/compiler-canonical-form'
status: mature
score: 96
updated: 2026-08-20
ingested:
  - source
  - agents/compiler-foundations.md
---

# compiler-canonical-form — Review

The dependency-free owner of host-independent canonical forms used in deterministic compiler output.

## Verdict

**mature — 96/100.** Two primitives define the byte-stable forms already repeated across compiler domains: exact UTF-16 code-unit text order and forward-slash path separators. Equality, empty and prefix values, ASCII case, non-ASCII and surrogate text, comparator laws, literal backslashes on every host, mixed and repeated separators, idempotence, and the deliberate absence of path-resolution or Unicode policy are direct-tested.

## What a fully expressed compiler canonical-form package looks like

- One exact total order whose result does not depend on host locale, process configuration, or input order. Present for text.
- Equality returns zero; lower and higher values return stable negative and positive values. Present as the narrow `-1 | 0 | 1` result.
- Comparator laws are executable specifications rather than assumptions made by callers. Present for representative compiler text.
- Path separator form treats backslash as a separator on every host rather than consulting the current host's `path.sep`. Present.
- Canonicalization is idempotent and does not silently resolve traversal, validate a path, or normalize Unicode. Present; domain owners compose those policies explicitly.
- No compiler contracts, filesystem, parser, target, or mutable global state. Present.

## Ownership boundary

This package owns only rules needed to make equivalent compiler bytes independent of locale and host separator conventions. It does not resolve `.` or `..`, make a path absolute, validate an emitted path, normalize Unicode, normalize source content, or choose case sensitivity. Those are identity policies owned by provenance, emission, inventory, or a target backend. Composite record precedence remains with the domain package that understands the fields.

## Present adoption

Patch precedence and audits, emitted-name allocation, runtime-contract requirements, inventory facts and reports, and orchestration modules, diagnostics, and files use the shared text order. Inventory, semantic lowering, emitted paths, memory workspaces, and Haxe and Rust source identity use the shared path form. Package health rejects local named text comparators outside this workspace and rejects locale-sensitive `localeCompare` throughout package source.

## Gaps

- Add another canonical-form primitive only after at least two packages demonstrate the same rule and laws. Unicode and content normalization do not currently meet that bar.
- UTF-16 code-unit order is portable and exact, not human-natural. User-facing presentation that needs locale-aware collation is a different, explicitly environmental concern and must not drive deterministic compiler artifacts.
