---
package: '@flighthq/compiler-emission'
status: near-mature
score: 80
updated: 2026-08-20
ingested:
  - source
  - agents/compiler-foundations.md
  - golden/
---

# compiler-emission — Review

The portable-output seam: ~1,000 lines across path/content normalization, target-name allocation and the tagged failure constructors both backends share. It owns the two questions every emitter asks and neither should answer twice — what may a generated file be called, and what may a generated identifier be called.

## Verdict

**near-mature — 80/100.** Both halves are unusually well specified. Path rejection covers eleven hostile classes and I verified every one of them fires; name allocation now distinguishes fixed public spellings from renamable internal bindings and refuses a public collision rather than picking a winner by declaration order, which closes a defect that emitted two `pub fn foo_bar` in one Rust file. What holds it under the high eighties is that the domain has a third question — what may a generated file _contain_ — and the package normalizes content without characterizing it.

## What a fully expressed target-output domain looks like

- **A portable path contract.** One place decides whether a relative path is safe on every supported host, rejecting absolute, drive-qualified, UNC, traversal, empty-segment, reserved-device, invalid-character, trailing-dot/space and control-character forms. Present.
- **Canonical path identity.** Two paths that name the same file on any supported host collide, including case-insensitive and Unicode-composition equivalence. Present.
- **Deterministic target-name allocation** across a stated namespace, distinguishing names that are part of the published target API (fixed) from internal ones (renamable), with a defined precedence and a refusal when two fixed names collide. Present.
- **Content normalization with a stated contract** — line endings, final newline, and an explicit position on trailing whitespace, BOM, tabs and maximum line length.
- **An encoding contract.** Which encoding generated files are written in, what happens to non-ASCII identifiers and string content in each target, and whether a target requires escaping.
- **Emission-time budget and shape checks**: a file that is empty, a file with no declarations, a suspiciously large file — the shapes that indicate an upstream mistake rather than a legitimate output.
- **A file-header contract** so every generated artifact declares its generator, its input identity, and its do-not-edit status uniformly across targets.
- **Structured failure with codes and guards** rather than message matching. Present.

## Present capabilities

- **Eleven hostile path classes rejected, verified individually.** POSIX absolute, Windows drive, UNC, traversal, empty segment, reserved device at top level and nested, invalid character, trailing dot, trailing space and NUL all refuse; an ordinary `flighthq/math/Clamp.hx` passes. I ran each class rather than reading the predicate.
- **Canonicalization as its own primitive.** `normalizeEmittedFilePath` separates separator canonicalization and Unicode composition from validation, and is idempotent — which matters because orchestration compares normalized paths to detect collisions across the emitted set.
- **Collision identity beyond exact match.** Case-only and Unicode-equivalent path collisions are rejected at the orchestration seam, so two files that differ only by case cannot both be written on a case-insensitive host.
- **Fixed-versus-renamable name allocation.** Public declarations keep the conventional target spelling; internal bindings yield and take a deterministic suffix; two fixed spellings that normalize to one target name fail with a tagged allocation failure converted to a standard backend refusal. The refusal names the shared spelling (`public declarations share fixed Rust target name foo_bar`) rather than reporting an abstract collision.
- **Order independence.** Preferred spellings are reserved before suffixing, so input order cannot choose which declaration wins — the property that makes the allocation reproducible across runs. Text tie-breaks use the shared `compiler-ordering` primitive. Ordering candidates by preferred spelling was provably unobservable; mutation found the term and it was removed rather than tested.
- **Tagged failures with bound registries.** `BackendEmissionFailure`, `CompilerInvariantFailure` and `CompilerTargetNameAllocationFailure` each carry a code union, a guard, and a `satisfies Record<Code, …>` binding so an added code fails to compile until the guard learns it.
- **Content normalization exists.** CRLF collapses and a single final newline is guaranteed, separated from path handling as its own primitive.

## Gaps

- **Content is normalized but not characterized.** The contract is "LF, one trailing newline". It says nothing about trailing whitespace on interior lines, tabs, BOM, or a maximum line width — all of which are real differences between what this compiler emits and what a target repository's own formatter would produce, and the migration goal is byte-for-byte equality with `flight-hx` output. Whichever way each is decided, it should be decided here rather than falling out of the emitters.
- **No encoding contract.** Nothing states that output is UTF-8, what happens to a non-ASCII identifier in a Haxe or Rust file, or whether any target needs escaping. Both backends will eventually meet an upstream identifier outside ASCII.
- **No generated-file header contract.** Each backend writes its own `// Generated by @flighthq/tool-compiler. Do not edit.` default and accepts an override option. A reference version owns the header here, including the input identity and upstream revision it was generated from, so a generated file in a downstream repository can be traced without guessing.
- **The namespace model is per-module, not per-target.** `createIrModuleTargetNameAllocation` allocates within one module. Cross-module collisions in the same target package — two modules both wanting a top-level `Config` in one Haxe package — are not this package's problem today, and will be when the emitters produce more than one file per package.
- **No output-shape checks.** An emitted file with zero declarations, or an emitted set with zero files, is legal here. Those are the "gate with no evidence" shapes the testing conventions warn about, and the compiler currently detects neither.
- **Binding collection had three unvisited expression positions.** Mutation showed that computed object keys, spread members, and template expression parts were never exercised, so a binding introduced inside any of them would have gone unallocated and emitted under its upstream spelling. The walk was correct; nothing proved it. Covered now, but the shape is worth remembering: the collector is a switch over the whole expression union, and only the arms a fixture happens to build are checked.
- **Indentation is a helper, not a contract.** `indentSourceLines` takes a depth and both backends call it with two-space semantics by convention. A target whose conventional indentation is tabs would have to know that independently.
