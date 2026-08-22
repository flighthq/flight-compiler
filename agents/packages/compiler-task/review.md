---
package: '@flighthq/compiler-task'
status: early
score: 48
updated: 2026-08-22
ingested:
  - source
  - agents/compiler-foundations.md
  - golden/
---

# compiler-task — Review

Target-neutral async analysis: what suspends, what a suspension means, and what a target must provide to run it. ~960 lines across an inventory, a state-machine analysis and task operation semantics, 16 tests. Async was the largest single refusal in both backends before this package existed.

## Verdict

**early — 48/100.** The framing is right and the hardest conceptual half is present: suspension points are found and owned by their nearest boundary, task operations have exact neutral semantics, and a linear async body lowers to a real state machine with completion paths. The score is early because the state machine handles **only linear bodies** — every structured construct refuses — and because no target elects a representation yet, so nothing this package produces reaches emitted source.

## What a fully expressed neutral task domain looks like

- Every suspension point located, owned by its nearest async boundary, with the lexical origin recorded. Present.
- Exact neutral semantics for the task operations the source language offers: ready, reject, join-all, then, catch, finally. Present.
- A completion-preserving state machine for **any** async body, not only a straight-line one. Present for linear bodies; absent for conditionals, loops, `switch` and `try`.
- Captured state and live locals carried across a suspension with proven liveness, so a resumed state sees what the source would have seen. Present in first form.
- Structured refusals for shapes no state machine can preserve, rather than an approximation. Present.
- A target capability contract naming what a runtime must supply — scheduling, settlement, cleanup — with each backend electing a representation. Contract present, election absent.
- No target syntax and no runtime implementation. Present.

## Present capabilities

- **Suspension ownership.** `await`, async declarations, methods, nested block and expression functions, and async iteration are inventoried with their nearest-boundary owner and lexical origin, so a nested closure's suspension is not attributed to the enclosing function.
- **Exact task operation semantics.** Ready, reject, join-all, then, catch and finally each have neutral meaning rather than a name; a `then` missing its fulfillment handler is a named refusal rather than an assumed identity.
- **Linear state machines with completion paths.** An async body without structured control flow becomes states with explicit transitions, and the value-completion path set travels with it, so a resumed state knows what it is completing.
- **Refusals that name the shape.** `unsupported-control-flow`, `unsupported-async-iteration`, `unsupported-suspension-expression`, `escaping-control-flow`, `unreachable-statement`. Each names the construct rather than reporting a generic failure.
- **Deterministic, deeply immutable output**, with the analysis reading through the shared traversal rather than its own walk.

## Gaps

- **The state machine is linear-only, and that is the whole gap.** `block`, `if`, `do`, `for`, `forIn`, `forOf`, `switch`, `while` and `try` all return `unsupported-control-flow`; `break` and `continue` return `escaping-control-flow`. An `await` inside an `if` — the most ordinary async code there is — has no machine. Conditional and structured branching is the single change that would move this score most.
- **Nothing elects a representation.** `CompilerRuntimeTaskCapabilityName` and the Haxe task lowering and emission contracts exist, but no backend produces task output, so both still refuse `await` outright. The analysis is currently write-only.
- **No cancellation or cleanup semantics beyond `finally`.** A task runtime needs a story for abandonment; the neutral model has none, and adding it after a target has shipped a representation is far more expensive.
- **Async iteration is inventoried but refused**, so `for await` has a location and no lowering.
- **Sixteen tests over ~960 lines of analysis** is thin for a domain this consequential, and the tests that exist lean on whole-module fixtures. The completion-path interaction in particular deserves counterexamples: a machine that drops a completion path still produces a plausible-looking machine.
