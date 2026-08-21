---
package: '@flighthq/compiler-emission'
status: mature
score: 90
updated: 2026-08-20
ingested:
  - source
  - agents/compiler-foundations.md
  - golden/
---

# compiler-emission — Review

The portable-output seam: ~1,000 lines across path/content normalization, target-name allocation and the tagged failure constructors both backends share. It owns the two questions every emitter asks and neither should answer twice — what may a generated file be called, and what may a generated identifier be called.

## Verdict

**mature — 90/100.** All three portable-output questions now have explicit contracts: path identity, target-name identity, and source contents. The contents seam preserves semantic whitespace, canonicalizes transport newlines, rejects BOM-prefixed and ill-formed Unicode text before UTF-8 can replace it, and offers exact BOM-free UTF-8 encoding. Generated headers are one shared primitive with global input identity and optional validated upstream commit rather than two backend literals. The remaining gaps are policy above this primitive seam: legal empty-output shapes, cross-module target namespaces, and target-specific lexical escaping.

## What a fully expressed target-output domain looks like

- **A portable path contract.** One place decides whether a relative path is safe on every supported host, rejecting absolute, drive-qualified, UNC, traversal, empty-segment, reserved-device, invalid-character, trailing-dot/space and control-character forms. Present.
- **Canonical path identity.** Two paths that name the same file on any supported host collide, including case-insensitive and Unicode-composition equivalence. Present.
- **Deterministic target-name allocation** across a stated namespace, distinguishing names that are part of the published target API (fixed) from internal ones (renamable), with a defined precedence and a refusal when two fixed names collide. Present.
- **Content normalization with a stated contract** — line endings, final newline, and an explicit position on trailing whitespace, BOM, tabs and maximum line length. Present.
- **An encoding contract.** Generated contents are well-formed Unicode encoded as BOM-free UTF-8; target-language escaping remains a backend decision. Present.
- **Emission-time budget and shape checks**: a file that is empty, a file with no declarations, a suspiciously large file — the shapes that indicate an upstream mistake rather than a legitimate output.
- **A file-header contract** so every generated artifact declares its generator, its input identity, and its do-not-edit status uniformly across targets. Present; a validated upstream commit is included when orchestration supplies one.
- **Structured failure with codes and guards** rather than message matching. Present.

## Present capabilities

- **Eleven hostile path classes rejected, verified individually.** POSIX absolute, Windows drive, UNC, traversal, empty segment, reserved device at top level and nested, invalid character, trailing dot, trailing space and NUL all refuse; an ordinary `flighthq/math/Clamp.hx` passes. I ran each class rather than reading the predicate.
- **Canonicalization as its own primitive.** `normalizeEmittedFilePath` separates separator canonicalization and Unicode composition from validation, and is idempotent — which matters because orchestration compares normalized paths to detect collisions across the emitted set.
- **Collision identity beyond exact match.** Case-only and Unicode-equivalent path collisions are rejected at the orchestration seam, so two files that differ only by case cannot both be written on a case-insensitive host.
- **Fixed-versus-renamable name allocation.** Public declarations keep the conventional target spelling; internal bindings yield and take a deterministic suffix; two fixed spellings that normalize to one target name fail with a tagged allocation failure converted to a standard backend refusal. The refusal names the shared spelling (`public declarations share fixed Rust target name foo_bar`) rather than reporting an abstract collision.
- **Order independence.** Preferred spellings are reserved before suffixing, so input order cannot choose which declaration wins — the property that makes the allocation reproducible across runs. Text tie-breaks use the shared `compiler-canonical-form` primitive. Ordering candidates by preferred spelling was provably unobservable; mutation found the term and it was removed rather than tested.
- **Tagged failures with bound registries.** `BackendEmissionFailure`, `CompilerInvariantFailure` and `CompilerTargetNameAllocationFailure` each carry a code union, a guard, and a `satisfies Record<Code, …>` binding so an added code fails to compile until the guard learns it.
- **Source text is preserved while transport is canonicalized.** CRLF and lone CR collapse to LF, redundant final newlines collapse to one, and trailing spaces, tabs, interior BOM code points and unlimited line lengths remain untouched because they may be source semantics rather than formatter trivia.
- **UTF-8 encoding is lossless and explicit.** A leading BOM and unpaired UTF-16 surrogates fail with `unsafe-emitted-contents`; valid non-ASCII scalar values encode to exact BOM-free UTF-8 bytes.
- **Generated provenance is shared.** Haxe and Rust call the same header primitive. Every emitted header contains package, source, and module identity; callers may add the exact inventory `upstreamCommit`, which is format-validated before emission. Backend options no longer admit an arbitrary header that can erase provenance.

## Gaps

- **The upstream commit is not yet wired by the public compilation request.** The inventory already produces `upstreamCommit` and both backend options accept it, but the current facade compiles caller-supplied sources without carrying an inventory record. Headers still have complete input identity; the revision appears when the caller provides it. Freeze that request-level connection only when the facade owns an inventory-to-compilation workflow.
- **Target lexical escaping remains backend work.** The shared seam guarantees lossless Unicode scalar text and exact UTF-8 bytes. Whether a non-ASCII identifier is legal or a string code point must be escaped is language-specific and belongs in Haxe/Rust emission decisions rather than this package.
- **The namespace model is per-module, not per-target.** `createIrModuleTargetNameAllocation` allocates within one module. Cross-module collisions in the same target package — two modules both wanting a top-level `Config` in one Haxe package — are not this package's problem today, and will be when the emitters produce more than one file per package.
- **No output-shape checks.** An emitted file with zero declarations, or an emitted set with zero files, is legal here. Those are the "gate with no evidence" shapes the testing conventions warn about, and the compiler currently detects neither.
- **Binding collection had three unvisited expression positions.** Mutation showed that computed object keys, spread members, and template expression parts were never exercised, so a binding introduced inside any of them would have gone unallocated and emitted under its upstream spelling. The walk was correct; nothing proved it. Covered now, but the shape is worth remembering: the collector is a switch over the whole expression union, and only the arms a fixture happens to build are checked.
- **Indentation is a helper, not a contract.** `indentSourceLines` takes a depth and both backends call it with two-space semantics by convention. A target whose conventional indentation is tabs would have to know that independently.
