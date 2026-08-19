# Agent Documents

Durable implementation plans and migration state live here. These documents complement [AGENTS.md](../AGENTS.md), which defines the codebase invariants and required health gates.

- [Compiler foundations](compiler-foundations.md): dependency floor, maturity rubric, package audit, and bedrock-first work order.
- [Compiler migration roadmap](compiler-migration-roadmap.md): current readiness, downstream ownership boundaries, parity gates, extraction phases, and recommended next work.
- [Compiler naming](compiler-naming.md): globally unique concept files, exported declaration identity, and verb–type–modifier API grammar.

## Conventions

Repository-wide contributor conventions. These state the standard; the health gates enforce the parts a script can check.

- [Commit conventions](conventions/commits.md): Conventional Commit subject, closed type set, scope rules, and why no body or trailers.
- [npm script naming](conventions/npm-scripts.md): the `action:subject:modifier` grammar, `:check` as a mode rather than a subject, collapse aliases, and the current script surface.
