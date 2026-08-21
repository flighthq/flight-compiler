---
package: '@flighthq/compiler-patch'
status: near-mature
score: 90
updated: 2026-08-20
ingested:
  - source
  - agents/compiler-foundations.md
---

# compiler-patch — Review

Fingerprinted semantic patching in one implementation source and its colocated test, with four exported functions over shared contracts, canonical order, and exact provenance identity. It exists so a target port can correct upstream semantics without editing upstream source, and so that correction goes stale the moment the source it was written against changes.

## Verdict

**near-mature — 90/100.** Identity, definition integrity, precedence, immutable application, auditability, and dry-run analysis now form one coherent engine. Every patch is checked for a nonblank id, author reason, target identity, legal scope and operation payload, plus an exact SHA-256 expectation before resolution. `flight-compiler-patch-audit/2` records the selected backend and every ordered applied or skipped decision; `flight-compiler-patch-analysis/1` exposes exact before/after declaration snapshots without returning rewritten modules. Focused tests kill every generated mutation. The remaining work begins at real external-document and maintenance workflows, not another in-process validation branch.

## What a fully expressed semantic-patch domain looks like

- **Identity-bound edits.** A patch names what it targets and what it expects to find, and refuses when either has moved. Present.
- **A closed, sufficient operation set.** Rename, remove, replace-body, replace-type covers a lot; a complete version also expresses adding a declaration, changing a signature independently of a body, annotating (marking deprecated, attaching a target attribute), and wrapping rather than replacing.
- **Deterministic composition.** Two patches touching one declaration have a defined outcome, and the rule is scope precedence rather than authoring order. Present.
- **A document format and validating parser.** Patches are data. A reference version loads them from a versioned file, validates untyped input into the typed model with per-field diagnostics, and can round-trip them back out.
- **Dry-run and diff.** `analyzeSemanticPatchSet` returns the ordered set of changes and exact before/after declarations without mutating input or returning rewritten modules. Present.
- **Authorship and justification in the audit.** Not only which patches applied, but who wrote each, when, against which upstream revision, and the stated reason — so an audit answers "should this still exist" and not only "did it run".
- **Staleness as a workflow, not only an error.** When upstream moves, the tool can list every stale patch, show the diff between expected and current source, and offer to re-fingerprint the ones whose intent survives.
- **Coverage reporting.** Which upstream declarations are patched, which targets rely on which patches, and which patches nothing exercises.

## Present capabilities

- **Full definition and identity checking before mutation.** Malformed ids, reasons, targets, expectations, scopes, operation payloads and selected backends fail through distinct tagged codes. Unmatched target, ambiguous target, kind mismatch and stale fingerprint remain separately inspectable.
- **Immutable application, verified.** `applySemanticPatchSet` deep-clones the input, rebuilds modules through `map`/`filter` rather than mutating, and tracks declarations by module index so a rebuild cannot invalidate the index. I exercised rename-across-modules, remove-then-rename with position shift, two removes preserving order, cross-module remove plus replace-type, and neutral-then-backend on one declaration: all correct, caller input unchanged, output modules fresh objects.
- **Scope precedence is explicit.** Neutral patches run before backend patches, and IDs only order within a scope, so the winner of an overlap is decided by layering rather than by an alphabetical accident. This was a real defect earlier — precedence used to fall out of `id.localeCompare`, and renaming a patch id silently changed generated output.
- **A versioned audit.** `flight-compiler-patch-audit/2` records the selected backend and applied patches with fingerprint, operation, reason, scope and target. Backend-mismatched patches are deterministic records with a stable skip reason rather than an anonymous count.
- **A versioned dry run.** `flight-compiler-patch-analysis/1` reuses the application engine and returns exact before/after declaration snapshots plus the same audit application would produce. Removal deliberately has no after snapshot.
- **Conflict rejection.** Duplicate ids, two patches of the same operation on one target in one scope, and a remove combined with any other active patch on the same target are all refused up front.
- **Deterministic ordering.** Application order is stable and host-locale independent through the shared `compiler-canonical-form` primitive; the audit is reproducible.

## Gaps

- **In-memory typed literals are the only input.** `defineSemanticPatchSet` takes a `const` array. Application defensively validates those values, but there is no external document format, parser, or round trip. Add that boundary only when a downstream repository actually ships patches as untyped data.
- **The audit records author intent but not maintenance ownership.** A nonblank reason is mandatory, but there is no author identity, upstream revision, authored-at value, or decision link. Those fields need a durable workflow rather than timestamps added speculatively.
- **No staleness workflow.** A stale fingerprint is a hard failure with two hex strings. There is no command to list stale patches across a checkout, show what changed in the target declaration, or re-fingerprint the ones whose intent is unaffected — which is the ordinary maintenance task this domain generates.
- **Operation set is narrower than the domain.** No add, no signature-only change, no annotation, no wrap. Every correction must be expressible as rename/remove/replace-body/replace-type, and a target that needs an extra declaration cannot get one from a patch.
- **`replaceBody` and `replaceType` take IR by hand.** Authoring one means writing IR literals, which is verbose and couples patch authors to the IR shape. A reference version accepts source text and lowers it, so a patch reads like the code it installs.
- **No coverage view.** Nothing reports which upstream declarations are patched or which patches are unexercised, so a patch that stopped mattering is invisible until it goes stale.
