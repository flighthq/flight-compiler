# Agent Documents

Durable implementation plans and migration state live here. These documents complement [AGENTS.md](../AGENTS.md), which defines the codebase invariants and required health gates.

- [Compiler foundations](compiler-foundations.md): dependency floor, maturity rubric, package audit, and bedrock-first work order.
- [Compiler migration roadmap](compiler-migration-roadmap.md): current readiness, downstream ownership boundaries, parity gates, extraction phases, and recommended next work.
- [Compiler breadth](compiler-breadth.md): missing cells, the domains that should not become packages, and whether each existing package owns one irreducible job.
- [Compiler naming](compiler-naming.md): globally unique concept files, exported declaration identity, and verb–type–modifier API grammar.

## Conventions

Repository-wide contributor conventions. These state the standard; the health gates enforce the parts a script can check.

- [Commit conventions](conventions/commits.md): Conventional Commit subject, closed type set, scope rules, and why no body or trailers.
- [npm script naming](conventions/npm-scripts.md): the `action:subject:modifier` grammar, `:check` as a mode rather than a subject, collapse aliases, and the current script surface.
- [Testing conventions](conventions/testing.md): test structure, the two test lanes, what a bedrock test proves, proving a guard that lands with its fix, assertions that cannot fail, and instrument choice.

## Package Reviews

Per-package domain surveys following Flight's `agents/packages/<name>/` convention. Each asks what a reference, fully expressed version of that package's domain would look like, and measures the current source against it.

- [Package review index](packages/index.md): scores, the shape they make, and the gaps that recur across packages.
- [compiler-types](packages/compiler-types/review.md): the vocabulary everything else speaks.
- [compiler-provenance](packages/compiler-provenance/review.md): are two pieces of source the same thing.
- [compiler-patch](packages/compiler-patch/review.md): correct upstream semantics without editing upstream.
- [compiler-emission](packages/compiler-emission/review.md): portable generated-file identity, contents, and provenance.
- [compiler-inventory](packages/compiler-inventory/review.md): what is in this workspace and what does it export.
- [compiler-ir-validation](packages/compiler-ir-validation/review.md): is a target-neutral IR module structurally trustworthy.
- [compiler-semantic](packages/compiler-semantic/review.md): TypeScript in, neutral IR out.
- [compiler-lowering](packages/compiler-lowering/review.md): verified neutral IR-to-IR passes elected by backends.
- [compiler-canonical-form](packages/compiler-canonical-form/review.md): portable canonical forms for deterministic compiler data.
- [compiler-runtime-contract](packages/compiler-runtime-contract/review.md): prove every reachable ambient type/value symbol has one target binding decision.
- [compiler-backend-hx](packages/compiler-backend-hx/review.md): neutral IR in, idiomatic Haxe out.
- [compiler-backend-rs](packages/compiler-backend-rs/review.md): neutral IR in, idiomatic Rust out.
- [compiler-orchestration](packages/compiler-orchestration/review.md): compose the passes deterministically.
- [tool-compiler](packages/tool-compiler/review.md): the one published artifact.
