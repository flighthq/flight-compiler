---
package: '@flighthq/compiler-patch'
status: substantially-mature
score: 78
updated: 2026-08-20
ingested:
  - source
  - agents/compiler-foundations.md
---

# compiler-patch — Review

Fingerprinted semantic patching: ~670 lines across one implementation source and its colocated test, three exported functions, depending only on the shared contracts. It exists so a target port can correct upstream semantics without editing upstream source, and so that correction goes stale the moment the source it was written against changes.

## Verdict

**substantially-mature — 78/100.** The identity model is the strongest thing here and it is genuinely well built: a patch names package, source, export, expected kind and expected fingerprint, and every one of those is checked before anything is applied. The rewrite from in-place mutation to immutable rebuild is correct under multi-patch, cross-module, position-shifting and remove-then-patch scenarios — I stress-tested all of them. What it lacks is everything around the edges of the domain: patches can only come from typed in-process literals, the audit records what happened but not why it was allowed to, and there is no way to see what a patch set would do without doing it.

## What a fully expressed semantic-patch domain looks like

- **Identity-bound edits.** A patch names what it targets and what it expects to find, and refuses when either has moved. Present.
- **A closed, sufficient operation set.** Rename, remove, replace-body, replace-type covers a lot; a complete version also expresses adding a declaration, changing a signature independently of a body, annotating (marking deprecated, attaching a target attribute), and wrapping rather than replacing.
- **Deterministic composition.** Two patches touching one declaration have a defined outcome, and the rule is scope precedence rather than authoring order. Present.
- **A document format and validating parser.** Patches are data. A reference version loads them from a versioned file, validates untyped input into the typed model with per-field diagnostics, and can round-trip them back out.
- **Dry-run and diff.** `whatWouldThisDo` before `doThis`: the set of declarations that would change, and the before/after of each, without mutating anything.
- **Authorship and justification in the audit.** Not only which patches applied, but who wrote each, when, against which upstream revision, and the stated reason — so an audit answers "should this still exist" and not only "did it run".
- **Staleness as a workflow, not only an error.** When upstream moves, the tool can list every stale patch, show the diff between expected and current source, and offer to re-fingerprint the ones whose intent survives.
- **Coverage reporting.** Which upstream declarations are patched, which targets rely on which patches, and which patches nothing exercises.

## Present capabilities

- **Full identity checking before mutation.** Unmatched target, ambiguous target, kind mismatch and stale fingerprint are each a distinct tagged failure with a code and a guard, thrown before any change is made.
- **Immutable application, verified.** `applySemanticPatchSet` deep-clones the input, rebuilds modules through `map`/`filter` rather than mutating, and tracks declarations by module index so a rebuild cannot invalidate the index. I exercised rename-across-modules, remove-then-rename with position shift, two removes preserving order, cross-module remove plus replace-type, and neutral-then-backend on one declaration: all correct, caller input unchanged, output modules fresh objects.
- **Scope precedence is explicit.** Neutral patches run before backend patches, and IDs only order within a scope, so the winner of an overlap is decided by layering rather than by an alphabetical accident. This was a real defect earlier — precedence used to fall out of `id.localeCompare`, and renaming a patch id silently changed generated output.
- **A versioned audit.** `flight-compiler-patch-audit/1` records applied patches with fingerprint, operation, reason, scope and target, and reports skipped backend-scoped patches as visible rather than absent.
- **Conflict rejection.** Duplicate ids, two patches of the same operation on one target in one scope, and a remove combined with any other active patch on the same target are all refused up front.
- **Deterministic ordering.** Application order is stable and host-locale independent through the shared `compiler-ordering` primitive; the audit is reproducible.

## Gaps

- **In-memory typed literals are the only input.** `defineSemanticPatchSet` takes a `const` array. There is no file format, no parser, no validation of untyped data, and therefore no way for a downstream repository to ship patches as data rather than as TypeScript that imports this package. The foundations audit defers this deliberately — "add a parser only when patches are loaded from untyped external data" — and that day arrives the moment `flight-hx` carries its own corrections.
- **No dry run.** There is no way to ask what a patch set would change. For an operation whose entire purpose is deliberate intervention in generated output, "apply it and read the diff" is the only preview, and that requires a full compile.
- **The audit records the what, not the why it is still valid.** `reason` is free text supplied by the author; there is no upstream revision, no authored-at, no link to the issue or decision. An audit six months old cannot tell a reader whether the patch is still needed.
- **No staleness workflow.** A stale fingerprint is a hard failure with two hex strings. There is no command to list stale patches across a checkout, show what changed in the target declaration, or re-fingerprint the ones whose intent is unaffected — which is the ordinary maintenance task this domain generates.
- **Operation set is narrower than the domain.** No add, no signature-only change, no annotation, no wrap. Every correction must be expressible as rename/remove/replace-body/replace-type, and a target that needs an extra declaration cannot get one from a patch.
- **`replaceBody` and `replaceType` take IR by hand.** Authoring one means writing IR literals, which is verbose and couples patch authors to the IR shape. A reference version accepts source text and lowers it, so a patch reads like the code it installs.
- **No coverage view.** Nothing reports which upstream declarations are patched or which patches are unexercised, so a patch that stopped mattering is invisible until it goes stale.
- **One untagged throw remains.** The defensive `throw new Error('Semantic patch index lost declaration …')` is the single failure in the file that `isSemanticPatchFailure` will not catch — measured as never executed by `npm run untested`. Small, but it is the exception in a package whose theme is tagged failures.
