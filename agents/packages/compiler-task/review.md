---
package: '@flighthq/compiler-task'
status: solid
score: 72
updated: 2026-08-22
ingested:
  - source
  - agents/compiler-foundations.md
  - golden/
---

# compiler-task — Review

Target-neutral async analysis: what suspends, what a suspension means, and what a target must provide to run it. ~960 lines across an inventory, a state-machine analysis and task operation semantics, 16 tests. Async was the largest single refusal in both backends before this package existed.

## Verdict

**solid — 72/100.** The state machine now compiles structured control flow, and Haxe renders all of it: branches, loops with real back edges, `break` and `continue` to the loop's own targets, and a `try`/`catch` whose handler receives the rejection of a suspended task. What a target sees is no longer a linear slice of async but most of the shape ordinary async code has. Two things hold the score short of near-mature: `finally` around a suspension still refuses, because it runs on every route out of the block and needs the completion algebra's replacement rather than a handler state; and `for await` has no runtime protocol to lower into. Rust still has no task representation at all, so this is Haxe-only in practice.

## What a fully expressed neutral task domain looks like

- Every suspension point located, owned by its nearest async boundary, with the lexical origin recorded. Present.
- Exact neutral semantics for the task operations the source language offers: ready, reject, join-all, then, catch, finally. Present.
- A completion-preserving state machine for **any** async body, not only a straight-line one. Present for blocks, conditionals, `while` and `do`-`while` loops, `switch` (through a neutral rewrite into branches), and `try`/`catch`; absent for `finally` and `for await`.
- Captured state and live locals carried across a suspension with proven liveness, so a resumed state sees what the source would have seen. Present in first form.
- Structured refusals for shapes no state machine can preserve, rather than an approximation. Present.
- A target capability contract naming what a runtime must supply — scheduling, settlement, cleanup — with each backend electing a representation. Contract present, election absent.
- No target syntax and no runtime implementation. Present.

## Present capabilities

- **Suspension ownership.** `await`, async declarations, methods, nested block and expression functions, and async iteration are inventoried with their nearest-boundary owner and lexical origin, so a nested closure's suspension is not attributed to the enclosing function.
- **Exact task operation semantics.** Ready, reject, join-all, then, catch and finally each have neutral meaning rather than a name; a `then` missing its fulfillment handler is a named refusal rather than an assumed identity.
- **Structured state machines with completion paths.** States fall through in order the way basic blocks do; a `branch` names two successors, a `goto` names one, a `loop` names a header the back edge re-enters, and a `guard` opens a region whose body and handler share a join. The value-completion path set travels with all of it.
- **A statement that cannot suspend runs in one state.** The gate is its completion set: `normal` and `throw` may run opaquely, because an execute step already registers the statement as an abrupt completion path; `return`, `break` and `continue` escaping the statement each mean something the machine has to represent, so they take the structured route instead.
- **Jumps reach the targets the loop already has.** `break` goes to the loop join and `continue` to the loop header. Labelled jumps still refuse.
- **Rejections reach source handlers.** A suspension inside a `try` names its handler, so a rejected task enters the source `catch` with the caught value bound as written, rather than settling the whole function.
- **Per-iteration lifetime is preserved.** A binding the suspension itself initializes lives in the resumed state, so a loop body's `const` is recreated each iteration rather than shared — the failure that produces working-looking code with one variable where the source had many.
- **Refusals that name the shape.** `unsupported-control-flow`, `unsupported-async-iteration`, `unsupported-suspension-expression`, `escaping-control-flow`, `unreachable-statement`. Each names the construct rather than reporting a generic failure.
- **Deterministic, deeply immutable output**, with the analysis reading through the shared traversal rather than its own walk.

## Gaps

- **`finally` around a suspension refuses.** It runs on every route out of the block — normal, `return`, `throw`, `break` — so it needs `compiler-completion`'s finally replacement rather than another state identity. This is the last structured form outstanding.
- **`for await` refuses for a runtime reason, not a control-flow one.** Its loop shape is already compiled here; what is missing is an async-iterator protocol in the runtime contract — how a target obtains an iterator and what a settled iteration result looks like. That is a runtime-surface decision, not a state shape.
- **Labelled jumps and labelled loops refuse.** The completion algebra models targeted completions exactly; the machine has no name for a label yet.
- **A suspension inside a `catch` body refuses**, so recovery cannot itself await.
- **Nothing elects a representation.** `CompilerRuntimeTaskCapabilityName` and the Haxe task lowering and emission contracts exist, but no backend produces task output, so both still refuse `await` outright. The analysis is currently write-only.
- **No cancellation or cleanup semantics beyond `finally`.** A task runtime needs a story for abandonment; the neutral model has none, and adding it after a target has shipped a representation is far more expensive.
- **Async iteration is inventoried but refused**, so `for await` has a location and no lowering.
- **Sixteen tests over ~960 lines of analysis** is thin for a domain this consequential, and the tests that exist lean on whole-module fixtures. The completion-path interaction in particular deserves counterexamples: a machine that drops a completion path still produces a plausible-looking machine.
